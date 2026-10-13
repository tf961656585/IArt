type RuntimeTestGlobal = typeof globalThis & {
  __IARTS_DATA_ROOT?: string;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  FileReader?: unknown;
};

const runtimeGlobal = globalThis as RuntimeTestGlobal;

export function setIartsDataRoot(value: string): void {
  runtimeGlobal.__IARTS_DATA_ROOT = value;
}

export function clearIartsDataRoot(): void {
  delete runtimeGlobal.__IARTS_DATA_ROOT;
}

export function enableReactActEnvironment(): () => void {
  runtimeGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    delete runtimeGlobal.IS_REACT_ACT_ENVIRONMENT;
  };
}

export function getGlobalFileReader<TFileReader>(): TFileReader | undefined {
  return runtimeGlobal.FileReader as TFileReader | undefined;
}

export function setGlobalFileReader(value: unknown): void {
  runtimeGlobal.FileReader = value;
}
