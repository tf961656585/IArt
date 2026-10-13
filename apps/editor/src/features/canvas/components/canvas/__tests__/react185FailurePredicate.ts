export const isReact185FailureMessage = (value: unknown): boolean => {
  const text = String(value);
  return (
    text.includes('Maximum update depth exceeded') ||
    text.includes('Minified React error #185') ||
    text.includes('react.dev/errors/185')
  );
};

export const hasReact185Failure = (calls: ReadonlyArray<ReadonlyArray<unknown>>): boolean =>
  calls.some((call) => call.some((part) => isReact185FailureMessage(part)));
