/**
 * S3-compatible storage client.
 *
 * Wraps @aws-sdk/client-s3 with explicit NodeHttpHandler for R2/Electron
 * compatibility and R2-specific configuration tweaks.
 *
 * ## R2 Compatibility
 *
 * Cloudflare R2 requires:
 *   - `forcePathStyle: true` — path-style URLs (the default for this plugin)
 *   - `disableHostPrefix: true` — prevents the SDK from prepending the
 *     bucket as a subdomain (which R2 doesn't support without a Worker)
 *   - `NodeHttpHandler` — uses Node.js http/https instead of browser fetch
 *     (Electron's fetch has issues with non-CORS endpoints)
 *   - Region set to "auto"
 */

import {
	S3Client as AwsS3Client,
	HeadObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
	type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { S3SyncSettings, S3ObjectInfo } from "./types";

/** Build the S3 client configuration shared across constructor + reconfigure. */
function buildClientConfig(settings: S3SyncSettings) {
	const endpoint = normalizeEndpoint(settings.endpoint);

	return {
		endpoint: endpoint || undefined,
		region: settings.region || "us-east-1",
		credentials: {
			accessKeyId: settings.accessKeyId,
			secretAccessKey: settings.secretAccessKey,
		},
		forcePathStyle: settings.forcePathStyle,
		// R2 / non-AWS: disable the SDK from prepending bucket as subdomain
		disableHostPrefix: true,
		// Explicitly use Node.js HTTP handler — avoids browser-fetch issues
		// in Electron where fetch can fail for non-CORS endpoints (R2, MinIO, etc.)
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 15000,
			requestTimeout: 60000,
		}),
		// R2 / non-AWS: do not compute checksums for uploads unless required,
		// and don't fail on missing checksums from the server
		requestChecksumCalculation: "WHEN_REQUIRED" as const,
		responseChecksumValidation: "WHEN_REQUIRED" as const,
	};
}

/**
 * Normalize an endpoint URL for the AWS SDK.
 * - Strips trailing slashes
 * - Ensures a protocol (https://) if none is present
 */
function normalizeEndpoint(url: string): string {
	let cleaned = url.trim();
	if (!cleaned) return "";

	// Strip trailing slashes
	while (cleaned.endsWith("/")) {
		cleaned = cleaned.slice(0, -1);
	}

	// Add https:// if no protocol
	if (!/^https?:\/\//i.test(cleaned)) {
		cleaned = "https://" + cleaned;
	}

	return cleaned;
}

export class S3Client {
	private client: AwsS3Client;
	private bucket: string;
	private prefix: string;
	private currentEndpoint: string;

	constructor(settings: S3SyncSettings) {
		this.bucket = settings.bucket;
		this.prefix = settings.prefix;
		this.currentEndpoint = normalizeEndpoint(settings.endpoint);

		this.client = new AwsS3Client(buildClientConfig(settings));
	}

	/** Rebuild the inner client (used when settings change). */
	reconfigure(settings: S3SyncSettings): void {
		this.client.destroy();
		this.bucket = settings.bucket;
		this.prefix = settings.prefix;
		this.currentEndpoint = normalizeEndpoint(settings.endpoint);

		this.client = new AwsS3Client(buildClientConfig(settings));
	}

	/**
	 * Test connectivity with detailed error reporting.
	 * Attempts a ListObjectsV2 with MaxKeys=1 to verify the bucket is reachable.
	 */
	async testConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
		const targetUrl = this.currentEndpoint
			? `${this.currentEndpoint}/${this.bucket}`
			: `https://s3.${this.client.config.region}.amazonaws.com/${this.bucket}`;

		try {
			await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: this.prefix || undefined,
					MaxKeys: 1,
				})
			);
			return { ok: true };
		} catch (err: any) {
			// Build a helpful error message
			const code = err.name ?? "UnknownError";
			const message = err.message ?? String(err);
			const httpStatus = err.$metadata?.httpStatusCode ?? "";

			const parts = [
				`[${code}] ${message}`,
				httpStatus ? `HTTP ${httpStatus}` : "",
				`Target: ${targetUrl}`,
			].filter(Boolean);

			return { ok: false, error: parts.join(" — ") };
		}
	}

	// ─── Path ↔ Key conversion ────────────────────────────────────

	vaultPathToKey(vaultPath: string): string {
		const normalised = vaultPath.replace(/\\/g, "/");
		return this.prefix ? `${this.prefix}${normalised}` : normalised;
	}

	keyToVaultPath(key: string): string {
		if (this.prefix && key.startsWith(this.prefix)) {
			return key.slice(this.prefix.length);
		}
		return key;
	}

	// ─── Core Operations ──────────────────────────────────────────

	/** HEAD — get metadata without downloading the body. */
	async headObject(vaultPath: string): Promise<HeadObjectCommandOutput | null> {
		const key = this.vaultPathToKey(vaultPath);
		try {
			const response = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key })
			);
			return response;
		} catch (err: any) {
			if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
				return null;
			}
			throw err;
		}
	}

	/** GET — download object body as Uint8Array. */
	async getObject(vaultPath: string): Promise<{
		body: Uint8Array;
		etag: string;
		versionId?: string;
		lastModified: Date;
	} | null> {
		const key = this.vaultPathToKey(vaultPath);
		try {
			const response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key })
			);
			if (!response.Body) return null;

			const body = await response.Body.transformToByteArray();
			return {
				body,
				etag: cleanETag(response.ETag ?? ""),
				versionId: response.VersionId,
				lastModified: response.LastModified ?? new Date(0),
			};
		} catch (err: any) {
			if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
				return null;
			}
			throw err;
		}
	}

	/** PUT — upload an object. */
	async putObject(
		vaultPath: string,
		body: Uint8Array | string,
		contentType: string = "application/octet-stream"
	): Promise<{ etag: string; versionId?: string }> {
		const key = this.vaultPathToKey(vaultPath);

		const response = await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
				ContentType: contentType,
			})
		);

		return {
			etag: cleanETag(response.ETag ?? ""),
			versionId: response.VersionId,
		};
	}

	/** DELETE — remove an object. */
	async deleteObject(vaultPath: string): Promise<void> {
		const key = this.vaultPathToKey(vaultPath);
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
		);
	}

	// ─── Listing ──────────────────────────────────────────────────

	/** List all objects under the configured prefix (paginated). */
	async listAllObjects(): Promise<S3ObjectInfo[]> {
		const objects: S3ObjectInfo[] = [];
		let continuationToken: string | undefined;

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: this.prefix || undefined,
					ContinuationToken: continuationToken,
					MaxKeys: 1000,
				})
			);

			if (response.Contents) {
				for (const obj of response.Contents) {
					if (!obj.Key) continue;
					// Skip directory markers (keys ending with / and zero size)
					if (obj.Key.endsWith("/") && (obj.Size ?? 0) === 0) continue;

					objects.push({
						key: obj.Key,
						etag: cleanETag(obj.ETag ?? ""),
						versionId: (obj as any).VersionId as string | undefined,
						lastModified: obj.LastModified ?? new Date(0),
						size: obj.Size ?? 0,
					});
				}
			}

			continuationToken = response.NextContinuationToken;
		} while (continuationToken);

		return objects;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * ETags from S3 are typically wrapped in double-quotes (e.g., `"abc123"`).
 * Strip them for consistent comparisons.
 */
function cleanETag(etag: string): string {
	let cleaned = etag;
	if (cleaned.startsWith('"')) cleaned = cleaned.slice(1);
	if (cleaned.endsWith('"')) cleaned = cleaned.slice(0, -1);
	return cleaned;
}
