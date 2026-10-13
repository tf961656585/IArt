export const buildGetProjectIpcResult = <TProject,>(
  getProject: (args: { projectPath: string; allowEmpty: boolean | undefined }) => TProject | null,
  args: { projectPath: string; allowEmpty: boolean | undefined },
): {
  project: TProject | null;
  failure: unknown;
} => {
  try {
    return { project: getProject(args), failure: null };
  } catch (error) {
    const failure =
      error && typeof error === 'object' && 'failure' in error
        ? (error as { failure: unknown | undefined }).failure
        : null;
    if (failure && typeof failure === 'object') {
      return { project: null, failure };
    }
    throw error;
  }
};
