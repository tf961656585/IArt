type UnknownObject = object;

const asUnknownObject = (value: unknown): UnknownObject | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

const readUnknownField = (value: UnknownObject, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor ? (descriptor.value as unknown) : undefined;
};

export {
  asUnknownObject,
  readUnknownField,
};
