export type CiContext = {
  provider: "gitlab" | "github" | "unknown";
  jobId?: string;
  pipelineId?: string;
  projectPath?: string;
  mergeRequestIid?: string;
  branch?: string;
};

export function detectCi(): CiContext {
  if (process.env.GITLAB_CI === "true") {
    return {
      provider: "gitlab",
      jobId: process.env.CI_JOB_ID,
      pipelineId: process.env.CI_PIPELINE_ID,
      projectPath: process.env.CI_PROJECT_PATH,
      mergeRequestIid: process.env.CI_MERGE_REQUEST_IID,
      branch: process.env.CI_COMMIT_REF_NAME
    };
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    return {
      provider: "github",
      jobId: process.env.GITHUB_RUN_ID,
      pipelineId: process.env.GITHUB_RUN_NUMBER,
      projectPath: process.env.GITHUB_REPOSITORY,
      branch: process.env.GITHUB_REF_NAME
    };
  }

  return { provider: "unknown" };
}
