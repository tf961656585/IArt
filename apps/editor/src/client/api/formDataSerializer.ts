import { isBlobLike } from '@/shared/isBlobLike';

export type SerializedFormDataFile = {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  dataBase64: string;
  size: number | undefined;
};

export type SerializedFormData = {
  __formData: {
    fields: Array<{ name: string; value: string }>;
    files: SerializedFormDataFile[];
  };
};

export const isSerializedFormData = (value: unknown): value is SerializedFormData => {
  if (!value || typeof value !== 'object') return false;
  const record = value as { __formData: unknown | undefined };
  if (!record.__formData || typeof record.__formData !== 'object') return false;
  const form = record.__formData as { fields: unknown | undefined; files: unknown | undefined };
  return Array.isArray(form.fields) || Array.isArray(form.files);
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(buffer).toString('base64');
    }
  } catch {
    // ignore
  }
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

export { isBlobLike };

export const collectFormDataEntries = (formData: FormData): Array<[string, FormDataEntryValue]> => {
  const entries: Array<[string, FormDataEntryValue]> = [];
  formData.forEach((value, name) => {
    entries.push([name, value]);
  });
  return entries;
};

export const serializeFormDataForBusinessAction = async (form: FormData): Promise<SerializedFormData> => {
  const fields: Array<{ name: string; value: string }> = [];
  const files: SerializedFormDataFile[] = [];

  for (const [name, value] of collectFormDataEntries(form)) {
    if (typeof value === 'string') {
      fields.push({ name, value });
      continue;
    }
    if (!isBlobLike(value)) {
      fields.push({ name, value: String(value) });
      continue;
    }
    const buffer = await value.arrayBuffer();
    const dataBase64 = arrayBufferToBase64(buffer);
    const contentType = value.type || undefined;
    const filename = typeof File !== 'undefined' && value instanceof File ? value.name : undefined;
    files.push({
      name,
      filename,
      contentType,
      dataBase64,
      size: value.size,
    });
  }

  return { __formData: { fields, files } };
};
