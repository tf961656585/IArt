import { request } from './client';

export type UploadServiceResponse = {
  url: string | undefined;
  success: boolean | undefined;
  error: string | undefined;
  message: string | undefined;
};

export interface UploadHttpExecutor {
  postForm: (
    endpoint: string,
    form: FormData,
    opts: {
      /** 默认 false；上传服务通常不需要携带业务 API Key */
      includeAuth: boolean | undefined;
      /** 默认 false；当 endpoint 为绝对 URL 时通常应为 false，避免被 resolveApiEndpoint 改写 */
      resolveEndpoint: boolean | undefined;
    } | undefined
  ) => Promise<UploadServiceResponse>;
}

class RequestUploadHttpExecutor implements UploadHttpExecutor {
  async postForm(
    endpoint: string,
    form: FormData,
    opts: { includeAuth: boolean | undefined; resolveEndpoint: boolean | undefined } | undefined
  ): Promise<UploadServiceResponse> {
    return request<UploadServiceResponse>({
      method: 'POST',
      endpoint,
      body: form,
      responseType: 'json',
      includeAuth: (opts !== null && opts !== undefined ? opts.includeAuth : undefined) ?? false,
      resolveEndpoint: (opts !== null && opts !== undefined ? opts.resolveEndpoint : undefined) ?? false,
    });
  }
}

let currentExecutor: UploadHttpExecutor = new RequestUploadHttpExecutor();

export const getUploadHttpExecutor = (): UploadHttpExecutor => currentExecutor;

export const setUploadHttpExecutor = (next: UploadHttpExecutor): void => {
  currentExecutor = next;
};
