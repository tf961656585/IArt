import { FamilyTemplateParameterDescriptorSchema } from '@iart/contracts';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import { buildFamilyTemplateParameterDescriptor } from '../generation-family-templates.registry.cts';

/**
 * 族模板参数描述只读路由（生成模型参数高级自定义设计 §3.4）。
 *
 * - GET /api/generation-family-templates/:familyAdapterId
 *   返回 FamilyTemplateParameterDescriptor：Hub 参数编辑器官方参数区的数据源。
 *
 * 两种「拿不到描述」必须给出不同响应，否则扩族期的排查会误判：
 * - 404：路径上的 id 不是已登记的接口类型（拼写错误、已删掉的旧 id）。
 * - 501：是合法的接口类型，但该族的模板规则尚未实现（后续批次逐族补齐）。Hub 侧按
 *   「这一类的参数暂时还不能自定义」呈现，而不是「没有这类模型」。
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
      const result = buildFamilyTemplateParameterDescriptor(familyAdapterId);
      if (result.kind === 'unknown') {
        loggingModule.logDebug('[generation-family-template-routes] unknown family adapter id', {
          familyAdapterId,
        });
        sendError(res, 404, ERROR_CODES.NOT_FOUND, '没有这类模型的参数模板', corsHeaders);
        return;
      }
      if (result.kind === 'pending') {
        // 501 而不是 404：这一族是真接口类型，只是模板规则还没落地（后续批次补齐）。
        loggingModule.logDebug('[generation-family-template-routes] family template pending', {
          familyAdapterId: result.familyAdapterId,
        });
        sendError(res, 501, 'not_implemented', '这个接口类型暂时还不能自定义参数', corsHeaders);
        return;
      }
      sendJson(
        res,
        200,
        FamilyTemplateParameterDescriptorSchema.parse(result.descriptor),
        NO_STORE_HEADERS(corsHeaders),
      );
    },
  },
];

export { createGenerationFamilyTemplateRoutes };
