import { FamilyTemplateParameterDescriptorSchema } from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import { buildFamilyTemplateParameterDescriptor } from '../generation-family-templates.cts';

/**
 * 族模板参数描述只读路由（生成模型参数高级自定义设计 §3.4）。
 *
 * - GET /api/generation-family-templates/:familyAdapterId
 *   返回 FamilyTemplateParameterDescriptor：Hub 参数编辑器官方参数区的数据源。
 *
 * 只读投影：数据全部来自 Runtime Backend 内置族模板的 parameter_schema / payload_rules /
 * default_values / locales，模板仍是参数唯一事实源，本端点不构成第二事实源。
 * GET 只读不加 Hub write token（hub-local-write-policy 口径）。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const createGenerationFamilyTemplateRoutes = (): RouteDefinition[] => [
  {
    name: 'generation-family-template-parameters',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return req.method === 'GET' && segs[0] === 'api' && segs[1] === 'generation-family-templates' && segs.length === 3;
    },
    handle: async ({ res, pathname, corsHeaders }) => {
      const familyAdapterId = decodeURIComponent(splitPathname(pathname)[2] ?? '');
      const descriptor = buildFamilyTemplateParameterDescriptor(familyAdapterId);
      if (descriptor === null) {
        loggingModule.logDebug('[generation-family-template-routes] no family template for adapter id', {
          familyAdapterId,
        });
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这类模型的参数模板', corsHeaders);
        return;
      }
      sendJson(res, 200, FamilyTemplateParameterDescriptorSchema.parse(descriptor), NO_STORE_HEADERS(corsHeaders));
    },
  },
];

export { createGenerationFamilyTemplateRoutes };
