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
  // Provider 连接、Deployment 与 ActiveRoute 写路由（spec 03 §4/§6：Hub 是管理入口）。
  // ProviderConnection：POST /api/provider-connections、PUT/DELETE /:id、PUT /:id/lifecycle、PUT/DELETE /:id/credential
  // ModelDeployment：POST /api/model-deployments、PUT/DELETE /:id
  // ActiveRoute：PUT/DELETE /api/active-routes/:modelId
  // 均受 Hub write token 保护；GET 只读不加。
  if (pathname === '/api/provider-connections' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/provider-connections/')) {
    if (isMethod(method, 'POST') || isMethod(method, 'PUT') || isMethod(method, 'DELETE')) {
      return true;
    }
  }
  if (pathname === '/api/model-deployments' && isMethod(method, 'POST')) {
    return true;
  }
  if (pathname.startsWith('/api/model-deployments/')) {
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
