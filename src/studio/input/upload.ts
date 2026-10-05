import { VIDEO_CACHE_CONTROL } from "../../core/layout.ts";
import type { PresignedUpload } from "../../storage/storage.ts";
import type { VideoApiCall } from "../studio-fetch.ts";

// Mints presigned PUT URLs from the host's endpoint (the only server call), then uploads the original and
// each rendition straight to the bucket, into a fresh folder per upload.

function uploadToPresignedUrl(props: {
  url: string;
  body: Blob;
  contentType: string;
  onProgress: (loadedBytes: number) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", props.url);
    // Both headers are signed into the URL, so they must match what the presign asked for exactly.
    xhr.setRequestHeader("Content-Type", props.contentType);
    xhr.setRequestHeader("Cache-Control", VIDEO_CACHE_CONTROL);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        props.onProgress(event.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }

      reject(new Error(`Upload to storage failed (${xhr.status}).`));
    };

    // A network-level failure on a cross-origin PUT is almost always a missing or incomplete bucket CORS
    // policy: the browser blocks the request before any response arrives.
    xhr.onerror = () => {
      reject(
        new Error(
          "Upload to storage failed before reaching the bucket. Check that its CORS policy allows PUT from this origin with the content-type and cache-control headers."
        )
      );
    };

    xhr.send(props.body);
  });
}

export type UploadFile = { name: string; body: Blob; contentType: string };

/** Presigns and uploads every file into a fresh folder. `onProgress` reports a 0..1 fraction across all
 *  bytes. Returns a map of file name to public URL. */
export async function uploadFiles(props: {
  call: VideoApiCall;
  filename: string;
  files: UploadFile[];
  onProgress: (fraction: number) => void;
}): Promise<Map<string, string>> {
  const { uploads } = await props.call<{ uploads: PresignedUpload[] }>(
    { action: "presign", filename: props.filename, files: props.files.map(({ name, contentType }) => ({ name, contentType })) },
    "Could not get upload URLs"
  );
  const byName = new Map(uploads.map((upload) => [upload.name, upload]));
  const totalBytes = props.files.reduce((sum, file) => sum + file.body.size, 0) || 1;
  const publicUrls = new Map<string, string>();
  let uploadedBytes = 0;

  for (const file of props.files) {
    const target = byName.get(file.name);

    if (!target) {
      throw new Error(`Missing presigned URL for ${file.name}.`);
    }

    await uploadToPresignedUrl({
      url: target.uploadUrl,
      body: file.body,
      contentType: file.contentType,
      onProgress: (loaded) => props.onProgress((uploadedBytes + loaded) / totalBytes),
    });

    uploadedBytes += file.body.size;
    publicUrls.set(file.name, target.publicUrl);
  }

  return publicUrls;
}
