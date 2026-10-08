import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import mime from "mime-types";
import { minimatch } from "minimatch";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context, Probot, ProbotOctokit } from "probot";
import unzipper from "unzipper";
import { sanitizeZipEntryPath } from "../utils/zip.js";
import { buildArtifactPath } from "./url.js";

/**
 * Encapsulates repository owner and name with helper methods.
 */
export class Repo {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
  ) {}

  /**
   * Parses a repository full name in `owner/repo` format into a Repo.
   * @param fullName Repository full name
   * @returns The parsed Repo
   */
  static fromFullName(fullName: string): Repo {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repository full name: ${fullName}`);
    }
    return new Repo(owner, repo);
  }

  /**
   * Creates a Repo from a Probot event context.
   * @param context Event context that exposes the repository helper
   * @returns The Repo for the event's repository
   */
  static fromContext(context: Context): Repo {
    const { owner, repo } = context.repo();
    return new Repo(owner, repo);
  }

  /**
   * Parses the repository owner and name from an artifact document URL.
   * URL path must strictly match `/<visibility>/<owner>/<repo>/<workflowRunId>/<artifactName>/<filePath>`.
   * Throws an error if the URL is invalid or if any path component is missing.
   * @param url The artifact document URL
   * @returns The parsed Repo
   */
  static fromUrl(url: string): Repo {
    const parsedUrl = new URL(url);
    const parts = parsedUrl.pathname.split("/");

    // Expect ['', visibility, owner, repo, workflowRunId, artifactName, ...filePathParts]
    if (parts.length < 7) {
      throw new Error(`Incomplete artifact path in URL: ${url}`);
    }

    // Extract the required components from the URL path
    const [
      ,
      visibility,
      owner,
      repo,
      workflowRunId,
      artifactName,
      ...filePathParts
    ] = parts;
    const filePath = filePathParts.join("/");

    // Validate that all required components are present
    if (
      !visibility ||
      !owner ||
      !repo ||
      !workflowRunId ||
      !artifactName ||
      !filePath
    ) {
      throw new Error(
        `Missing required path components in URL (${url}): ${JSON.stringify({ visibility, owner, repo, workflowRunId, artifactName, filePath })}`,
      );
    }

    return new Repo(decodeURIComponent(owner), decodeURIComponent(repo));
  }

  /**
   * Returns the `owner/repo` full name of the repository.
   * @returns The full name in `owner/repo` format
   */
  toString(): string {
    return `${this.owner}/${this.repo}`;
  }

  /**
   * Checks if this repository equals another by owner and repo.
   * @param other The repository to compare with
   * @returns True if both owner and repo match
   */
  equals(other: Repo): boolean {
    return this.owner === other.owner && this.repo === other.repo;
  }
}

/**
 * Downloads GitHub Actions workflow artifacts.
 */
export class ArtifactDownloader {
  constructor(private readonly octokit: ProbotOctokit) {}

  /**
   * Downloads an artifact zip archive as a readable stream.
   * @param owner Repository owner
   * @param repo Repository name
   * @param artifactId GitHub artifact ID
   * @returns A readable stream for the downloaded zip archive
   */
  async downloadStream(
    owner: string,
    repo: string,
    artifactId: number,
  ): Promise<Readable> {
    const response = await this.octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifactId,
      archive_format: "zip",
      request: {
        parseSuccessResponseBody: false,
      },
    });
    return Readable.fromWeb(
      response.data as import("node:stream/web").ReadableStream,
    );
  }
}

/**
 * Target destination parameters for artifact upload.
 */
export interface ArtifactUploadTarget {
  owner: string;
  repo: string;
  workflowRunId: number;
  artifactName: string;
  visibility: "private" | "public";
}

/**
 * Unzips and uploads artifact files to AWS S3.
 */
export class ArtifactUploader {
  constructor(
    private readonly s3Client: S3Client,
    private readonly bucketName: string,
    private readonly log?: Probot["log"],
  ) {}

  /**
   * Parses zip stream on-the-fly and uploads each file sequentially to S3.
   * Skips directory entries and unsafe paths. Tracks and returns the path to the shallowest index.html found.
   * @param zipStream The readable stream representing the artifact zip archive
   * @param target Target repository and artifact metadata
   * @returns The path to the shallowest index.html found in the archive
   */
  async upload(
    zipStream: Readable,
    target: ArtifactUploadTarget,
  ): Promise<string | undefined> {
    const { owner, repo, workflowRunId, artifactName, visibility } = target;

    let shallowestIndexHtml: string | undefined;
    let shallowestDepth = Infinity;

    const tmpFilePath = path.join(os.tmpdir(), `${randomUUID()}.zip`);
    let activeUpload: Upload | undefined;

    try {
      // Download the entire ZIP stream to disk first to bypass unzipper.Parse() streaming constraints
      // (such as Zip64 incompatibility and Data Descriptor chunking bugs that cause "unexpected end of file").
      await pipeline(zipStream, createWriteStream(tmpFilePath));

      // Parse from disk. This reads the Central Directory at the end of the file, providing flawless
      // support for Zip64, Data Descriptors, and arbitrary chunking.
      const directory = await unzipper.Open.file(tmpFilePath);

      for (const file of directory.files) {
        if (file.type === "Directory") {
          continue;
        }

        const sanitizedPath = sanitizeZipEntryPath(file.path);
        if (!sanitizedPath) {
          continue;
        }

        // Update shallowest index.html track
        if (minimatch(sanitizedPath, "**/index.html", { dot: true })) {
          const depth = sanitizedPath.split("/").length;
          if (depth < shallowestDepth) {
            shallowestDepth = depth;
            shallowestIndexHtml = sanitizedPath;
          }
        }

        const s3Path = buildArtifactPath(
          visibility,
          owner,
          repo,
          workflowRunId,
          artifactName,
          sanitizedPath,
        );
        const contentType =
          mime.lookup(sanitizedPath) || "application/octet-stream";

        // Remove leading slash from the path to form the S3 key
        const s3Key = s3Path.startsWith("/") ? s3Path.substring(1) : s3Path;

        const entryStream = file.stream();
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucketName,
            Key: s3Key,
            Body: entryStream,
            ContentType: contentType,
          },
        });
        activeUpload = upload;

        await upload.done();
        activeUpload = undefined;
      }

      return shallowestIndexHtml;
    } catch (error) {
      if (activeUpload) {
        await activeUpload.abort().catch((err) => {
          this.log?.debug(
            { err },
            "Failed to abort multipart upload during error cleanup",
          );
        });
      }
      throw error;
    } finally {
      await rm(tmpFilePath, { force: true }).catch((err) => {
        this.log?.debug({ err }, "Failed to remove temporary ZIP file");
      });
      if (!zipStream.destroyed) {
        zipStream.destroy();
      }
    }
  }
}
