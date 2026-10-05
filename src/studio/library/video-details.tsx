"use client";

import { CopyIcon } from "@sanity/icons/Copy";
import { DownloadIcon } from "@sanity/icons/Download";
import { LaunchIcon } from "@sanity/icons/Launch";
import { TrashIcon } from "@sanity/icons/Trash";
import { WarningOutlineIcon } from "@sanity/icons/WarningOutline";
import { Box, Button, Card, Dialog, Flex, Grid, Spinner, Stack, Tab, TabList, TabPanel, Text } from "@sanity/ui";
import { Popover } from "@sanity/ui/popover";
import * as React from "react";
import { Preview, useSchema } from "sanity";
import { useRouter } from "sanity/router";
import { useVideoApi } from "../studio-fetch.ts";
import { deleteAsset, findReferencingDocs, presignDownload, type ReferencingDoc } from "./data.ts";
import { formatBytes, formatDate, type LibraryAsset, loadAssetDimensions, qualityLabel } from "./utils.ts";

// The details dialog. References (documents using the video) load on open and gate deletion: a video still
// in use cannot be deleted until it is removed from those documents, and neither can one whose references
// could not be checked.

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size={1} weight="semibold">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap={3}>
      <Text size={1} muted>
        {label}
      </Text>
      <Text size={1}>{value}</Text>
    </Flex>
  );
}

function OpenLink({ href }: { href: string }) {
  return <Button as="a" href={href} target="_blank" rel="noreferrer" mode="ghost" fontSize={1} icon={LaunchIcon} text="Open" />;
}

function DownloadButton({ href }: { href: string }) {
  const { call } = useVideoApi();
  const [pending, setPending] = React.useState(false);

  const download = async () => {
    setPending(true);

    try {
      const link = document.createElement("a");
      link.href = await presignDownload(call, href);
      link.rel = "noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch {
      window.open(href, "_blank", "noreferrer");
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      mode="ghost"
      fontSize={1}
      icon={DownloadIcon}
      text="Download"
      title="Download this file"
      disabled={pending}
      onClick={download}
    />
  );
}

function FileRow({ label, size, href }: { label: string; size?: string; href: string }) {
  return (
    <Flex align="center" justify="space-between" gap={3}>
      <Text size={1}>{label}</Text>
      <Flex align="center" gap={2}>
        {size && (
          <Text size={1} muted>
            {size}
          </Text>
        )}
        <DownloadButton href={href} />
        <OpenLink href={href} />
      </Flex>
    </Flex>
  );
}

export function VideoDetailsDialog({
  asset,
  onClose,
  onSelect,
  onDeleted,
  busy,
}: {
  asset: LibraryAsset;
  onClose: () => void;
  onSelect?: (asset: LibraryAsset) => void;
  onDeleted: () => void;
  busy: boolean;
}) {
  const { call, client } = useVideoApi();
  const schema = useSchema();
  const { navigateIntent } = useRouter();

  const [copied, setCopied] = React.useState(false);
  const [tab, setTab] = React.useState<"details" | "references">("details");
  const [references, setReferences] = React.useState<ReferencingDoc[] | null>(null);
  const [refsError, setRefsError] = React.useState<string | null>(null);
  const [refsLoading, setRefsLoading] = React.useState(true);
  const [dimensions, setDimensions] = React.useState<{ width: number; height: number } | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  // Renditions are ordered smallest first, so the last is the original.
  const largest = asset.renditions[asset.renditions.length - 1];
  const copyHref = largest?.url ?? asset.poster ?? null;
  const formats = Array.from(new Set(asset.renditions.map((r) => r.container.toUpperCase()))).join(", ");
  const refCount = references?.length ?? 0;

  React.useEffect(() => {
    let alive = true;

    loadAssetDimensions(asset).then((size) => {
      if (alive) {
        setDimensions(size);
      }
    });

    return () => {
      alive = false;
    };
  }, [asset]);

  React.useEffect(() => {
    let alive = true;
    setRefsLoading(true);
    setRefsError(null);

    findReferencingDocs(client, asset.id)
      .then((docs) => {
        if (alive) {
          setReferences(docs);
        }
      })
      .catch((error) => {
        // Unknown is not unused: without the references, deleting could break a page.
        if (alive) {
          setReferences(null);
          setRefsError(error instanceof Error ? error.message : "Could not check where this video is used.");
        }
      })
      .finally(() => {
        if (alive) {
          setRefsLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, [client, asset.id]);

  const copyUrl = async () => {
    if (!copyHref) {
      return;
    }

    try {
      await navigator.clipboard.writeText(copyHref);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard is blocked (no permission, or an insecure context); nothing to do.
    }
  };

  // A video in use surfaces the references tab and locks the button; otherwise go to the final confirm.
  const onDeleteClick = () => {
    if (refsLoading || refsError) {
      return;
    }

    if (refCount > 0) {
      setBlocked(true);
      setTab("references");
      return;
    }

    setConfirming(true);
  };

  const doDelete = async () => {
    setDeleting(true);
    setDeleteError(null);

    try {
      await deleteAsset(call, asset.id);
      onDeleted();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed.");
      setDeleting(false);
      setConfirming(false);
    }
  };

  const openDoc = (doc: ReferencingDoc) => navigateIntent("edit", { id: doc.id, type: doc.type });

  return (
    <Dialog id="video-details" header="Video details" width={3} onClose={onClose}>
      <Box padding={4}>
        {deleteError && (
          <Card tone="critical" padding={3} radius={2} marginBottom={4}>
            <Text size={1}>{deleteError}</Text>
          </Card>
        )}
        <Grid gridTemplateColumns={[1, 2]} gap={5}>
          <Stack gap={4}>
            {/* biome-ignore lint/a11y/useMediaCaption: a preview of an uploaded file, which carries no caption track to offer. */}
            <video
              controls
              playsInline
              preload="metadata"
              poster={asset.poster ?? undefined}
              style={{ width: "100%", borderRadius: 6, background: "#000" }}
            >
              {/* Preview the original, never the small tiers. */}
              {largest && <source src={largest.url} type={largest.container === "webm" ? "video/webm" : "video/mp4"} />}
            </video>

            <Stack gap={3}>
              <Row label="Total size" value={formatBytes(asset.bytes)} />
              <Row label="Dimensions" value={dimensions ? `${dimensions.width}×${dimensions.height}px` : "-"} />
              <Row label="Format" value={formats || "-"} />
              <Row label="Updated" value={formatDate(asset.updatedAt) || "-"} />
            </Stack>

            <Stack gap={3}>
              <Flex gap={2} align="center" wrap="wrap">
                {onSelect && (
                  <Button
                    text={busy ? "Linking…" : "Use this video"}
                    tone="primary"
                    disabled={busy || deleting}
                    onClick={() => onSelect(asset)}
                  />
                )}
                <Button
                  icon={CopyIcon}
                  mode="ghost"
                  text={copied ? "Copied" : "Copy URL"}
                  disabled={!copyHref}
                  onClick={copyUrl}
                />
                {largest && <OpenLink href={largest.url} />}
                <Popover
                  open={confirming}
                  portal
                  placement="top"
                  content={
                    <Box padding={3} style={{ maxWidth: 280 }}>
                      <Stack gap={3}>
                        <Text size={1}>
                          No documents use this video. Permanently delete it from the bucket? This can&rsquo;t be undone.
                        </Text>
                        <Flex gap={2} justify="flex-end">
                          <Button
                            text="Cancel"
                            mode="ghost"
                            fontSize={1}
                            disabled={deleting}
                            onClick={() => setConfirming(false)}
                          />
                          <Button
                            text={deleting ? "Deleting…" : "Delete"}
                            tone="critical"
                            fontSize={1}
                            disabled={deleting}
                            onClick={doDelete}
                          />
                        </Flex>
                      </Stack>
                    </Box>
                  }
                >
                  <Button
                    text={deleting ? "Deleting…" : "Delete"}
                    icon={TrashIcon}
                    tone="critical"
                    mode="ghost"
                    disabled={deleting || refsLoading || Boolean(refsError) || blocked}
                    onClick={onDeleteClick}
                  />
                </Popover>
              </Flex>
              {blocked && (
                <Card tone="caution" radius={2} padding={2}>
                  <Flex align="center" gap={2}>
                    <Text size={1}>
                      <WarningOutlineIcon />
                    </Text>
                    <Text size={1}>
                      Used in {refCount} {refCount === 1 ? "place" : "places"}. Remove it there first.
                    </Text>
                  </Flex>
                </Card>
              )}
              {refsError && (
                <Card tone="caution" radius={2} padding={2}>
                  <Text size={1}>Could not check where this video is used, so it cannot be deleted now: {refsError}</Text>
                </Card>
              )}
            </Stack>
          </Stack>

          <Stack gap={4}>
            <TabList gap={2}>
              <Tab
                aria-controls="video-details-panel"
                id="video-details-tab"
                label="Details"
                selected={tab === "details"}
                onClick={() => setTab("details")}
              />
              <Tab
                aria-controls="video-references-panel"
                id="video-references-tab"
                label={refsLoading || refsError ? "References" : `References (${refCount})`}
                selected={tab === "references"}
                onClick={() => setTab("references")}
              />
            </TabList>

            <TabPanel aria-labelledby="video-details-tab" id="video-details-panel" hidden={tab !== "details"}>
              <Stack gap={4}>
                <Field label="Name">
                  <Text size={1}>{asset.name}</Text>
                </Field>

                <Field label="Files">
                  <Stack gap={3}>
                    {asset.renditions.map((r) => (
                      <FileRow
                        key={r.url}
                        label={`${qualityLabel(r.quality)} · ${r.container}`}
                        size={formatBytes(r.bytes)}
                        href={r.url}
                      />
                    ))}
                    {asset.poster && <FileRow label="Poster" href={asset.poster} />}
                  </Stack>
                </Field>

                <Field label="Bucket key">
                  <Text size={1} muted style={{ wordBreak: "break-all" }}>
                    {asset.id}
                  </Text>
                </Field>
              </Stack>
            </TabPanel>

            <TabPanel aria-labelledby="video-references-tab" id="video-references-panel" hidden={tab !== "references"}>
              {refsLoading ? (
                <Flex padding={4} justify="center">
                  <Spinner muted />
                </Flex>
              ) : refsError ? (
                <Text size={1} muted>
                  Could not check where this video is used.
                </Text>
              ) : refCount === 0 ? (
                <Text size={1} muted>
                  Not used by any document. Safe to delete.
                </Text>
              ) : (
                <Card flex={1} padding={2} radius={2} shadow={1}>
                  <Stack gap={2}>
                    {(references ?? []).map((doc) => {
                      const schemaType = schema.get(doc.type);
                      return schemaType ? (
                        <Button key={doc.id} mode="bleed" padding={2} onClick={() => openDoc(doc)} style={{ width: "100%" }}>
                          <Preview layout="default" schemaType={schemaType} value={{ _id: doc.id, _type: doc.type }} />
                        </Button>
                      ) : (
                        <Box key={doc.id} padding={2}>
                          <Text size={1} muted>
                            {doc.title} <span style={{ opacity: 0.6 }}>· unknown type ({doc.type})</span>
                          </Text>
                        </Box>
                      );
                    })}
                  </Stack>
                </Card>
              )}
            </TabPanel>
          </Stack>
        </Grid>
      </Box>
    </Dialog>
  );
}
