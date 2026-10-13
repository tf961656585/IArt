type MediaCandidateExtractorContext = {
  statusUrl: string | null | undefined;
  successValue: unknown | undefined;
};

type DeriveMediaDownloadCandidatesOptions = {
  successValue: unknown | undefined;
};

const DEFAULT_MEDIA_CANDIDATE_EXTRACTOR_CONTEXT: MediaCandidateExtractorContext = {
  statusUrl: null,
  successValue: undefined,
};

const DEFAULT_DERIVE_MEDIA_DOWNLOAD_CANDIDATES_OPTIONS: DeriveMediaDownloadCandidatesOptions = {
  successValue: undefined,
};

export {
  type MediaCandidateExtractorContext,
  type DeriveMediaDownloadCandidatesOptions,
  DEFAULT_MEDIA_CANDIDATE_EXTRACTOR_CONTEXT,
  DEFAULT_DERIVE_MEDIA_DOWNLOAD_CANDIDATES_OPTIONS,
};
