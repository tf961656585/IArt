type MainWindowOpenCoordinatorOptions = {
  openMainWindow: (startUrl: string) => void;
};

const normalizeStartUrl = (value: string) => {
  const trimmed = value.trim();
  return trimmed || "about:blank";
};

export const createMainWindowOpenCoordinator = ({
  openMainWindow,
}: MainWindowOpenCoordinatorOptions) => {
  let startupStartUrl: string | null = null;
  let hasPendingOpenRequest = false;

  const openResolvedMainWindow = () => {
    if (!startupStartUrl) return false;
    hasPendingOpenRequest = false;
    openMainWindow(startupStartUrl);
    return true;
  };

  return {
    requestOpen: () => {
      if (openResolvedMainWindow()) return;
      hasPendingOpenRequest = true;
    },
    markStartupReady: (startUrl: string, options: { openNow: boolean | undefined } = { openNow: undefined }) => {
      startupStartUrl = normalizeStartUrl(startUrl);
      if (options.openNow || hasPendingOpenRequest) {
        openResolvedMainWindow();
      }
    },
    hasPendingOpenRequest: () => hasPendingOpenRequest,
  };
};
