import nock from "nock";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  nock.cleanAll();
  nock.enableNetConnect();
});
