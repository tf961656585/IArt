const isMethod = (value: unknown, expected: string) => {
  return typeof value === 'string' && value.toUpperCase() === expected;
};

const isHubLocalWriteProbeRoute = (method: unknown, pathname: string) => {
  return isMethod(method, 'GET') && pathname === '/api/hub/local-write-trust/probe';
};

const isHubLocalWriteGuardedRoute = (method: unknown, pathname: string) => {
  if (isMethod(method, 'PUT') && pathname === '/api/config') {
    return true;
  }
  if (pathname === '/api/prompt-presets' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/prompt-presets/') && (isMethod(method, 'PUT') || isMethod(method, 'DELETE'))) {
    return true;
  }
  // Provider 连接与 ActiveRoute 写路由（spec 03 §4/§6：Hub 是管理入口）。
  // ProviderConnection：POST /api/provider-connections、PUT/DELETE /:id、PUT /:id/lifecycle、PUT/DELETE /:id/credential
  // ActiveRoute：PUT/DELETE /api/active-routes/:modelId
  // 均受 Hub write token 保护；GET 只读不加。
  // 2026-10-19 起不再有 /api/model-deployments 写保护——该路由已随部署载体退场删除；模型的增删
  // 走两族记录自己的写路由（下面 custom-*-models 两段），它们各自受保护。
  if (pathname === '/api/provider-connections' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/provider-connections/')) {
    if (isMethod(method, 'POST') || isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  if (pathname.startsWith('/api/active-routes/')) {
    if (isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  // 思考档位预设池写路由（spec 37「思考档位」：档位池在主窗口维护）。
  // POST /api/thinking-tiers（新增自定义档）、DELETE /api/thinking-tiers/:name（删除 + 级联清理）
  // 均受 Hub write token 保护；GET 只读不加。
  if (pathname === '/api/thinking-tiers' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/thinking-tiers/') && isMethod(method, 'DELETE')) {
    return true;
  }
  // 用户自建对话模型写路由（spec 37「对话模型的唯一来源」：模型声明在主窗口维护）。
  // POST /api/custom-chat-models（添加自建模型）、PUT /api/custom-chat-models/:modelId（改上下文窗口）、
  // DELETE /api/custom-chat-models/:modelId（删除 + 级联清理接入与 active route）
  // 均受 Hub write token 保护；GET 只读不加。
  if (pathname === '/api/custom-chat-models' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/custom-chat-models/')) {
    if (isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  // 用户自建生成模型写路由（生成模型自建声明试点 §3.2：模型声明在主窗口维护）。
  // POST /api/custom-generation-models（添加自建生成模型）、PUT /api/custom-generation-models/:modelId
  // （改参考图支持与参数覆盖，生成模型参数高级自定义设计 §3.3）、
  // DELETE /api/custom-generation-models/:modelId（删除 + 级联清理接入与 active route）
  // 均受 Hub write token 保护；GET 只读不加。
  if (pathname === '/api/custom-generation-models' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/custom-generation-models/')) {
    if (isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  // 接口配方公共库（docs/custom-providers/接口配方-design.md §7/§8）：配方管理在主窗口。
  // POST /api/interface-recipes（新建）、PUT/DELETE /api/interface-recipes/:recipeId（改/删），
  // 外加两个计算路由 POST /dry-run、POST /path-discovery（同一信任域、由管理页发起，纯本地计算）。
  // GET 只读不加。
  if (pathname === '/api/interface-recipes' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/interface-recipes/')) {
    if (isMethod(method, 'POST') || isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  // 接口格式写路由（2026-10-26 批次 B5a：Hub 主窗口创建/维护用户自建格式）。
  // POST /api/interface-formats（创建，草稿 → 实体 + 判定配方）、
  // POST /api/interface-formats/:formatId/copy（复制，整实体克隆 + 配方处理）、
  // PUT/DELETE /api/interface-formats/:formatId（改/删用户格式；预设只读，由路由返回 409）。
  // GET 列表/详情不加；格式侧路径发现是纯本地计算且沿用就接口，本批口径不变。
  if (pathname === '/api/interface-formats' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/interface-formats/')) {
    if (pathname.endsWith('/copy') && isMethod(method, 'POST')) {
      return true;
    }
    if (isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  // 首次指引展示态写路由（docs/hub/首次指引-design.md §4.1：已看标记在主窗口写）。
  // PUT /api/onboarding-state（写 guideDismissed）受 Hub write token 保护；GET 只读不加。
  if (pathname === '/api/onboarding-state' && isMethod(method, 'PUT')) {
    return true;
  }
  return false;
};

export {
  isHubLocalWriteGuardedRoute,
  isHubLocalWriteProbeRoute,
};
