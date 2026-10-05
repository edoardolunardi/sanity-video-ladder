"use client";

import { FilterIcon } from "@sanity/icons/Filter";
import { RefreshIcon } from "@sanity/icons/Refresh";
import { SearchIcon } from "@sanity/icons/Search";
import { SortIcon } from "@sanity/icons/Sort";
import { ThLargeIcon } from "@sanity/icons/ThLarge";
import { ThListIcon } from "@sanity/icons/ThList";
import { Badge, Box, Button, Card, Flex, Grid, Spinner, Stack, Text, TextInput } from "@sanity/ui";
import { Menu, MenuButton, MenuItem } from "@sanity/ui/menu";
import * as React from "react";
import { formatBytes, formatDate, type LibraryAsset, qualityLabel } from "./utils.ts";
import { VideoDetailsDialog } from "./video-details.tsx";

// Grid or list of the bucket's videos, shared by the tool and the field picker. Passing `onSelect` adds the
// "Use this video" action for picking.

type View = "grid" | "list";
const VIEW_KEY = "sanity-video-ladder:view";

type SortKey = "date-desc" | "date-asc" | "name-asc" | "name-desc";
const SORT_KEY = "sanity-video-ladder:sort";
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "date-desc", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "name-asc", label: "Name (A-Z)" },
  { value: "name-desc", label: "Name (Z-A)" },
];

// Usage filter: the cleanup lens. "Unused" surfaces videos no document uses.
type UsageKey = "all" | "used" | "unused";
const USAGE_KEY = "sanity-video-ladder:usage";
const USAGE_OPTIONS: { value: UsageKey; label: string }[] = [
  { value: "all", label: "All videos" },
  { value: "used", label: "In use" },
  { value: "unused", label: "Unused" },
];

type Props = {
  assets: LibraryAsset[];
  loading: boolean;
  error: string | null;
  usageError?: string | null;
  onReload: () => void;
  onSelect?: (asset: LibraryAsset) => void;
  busyId?: string | null;
  columns?: number[];
};

type ItemProps = {
  asset: LibraryAsset;
  onSelect?: (asset: LibraryAsset) => void;
  busy: boolean;
  onOpenDetails: (asset: LibraryAsset) => void;
};

function usePersistedView(): [View, (v: View) => void] {
  const [view, setView] = React.useState<View>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "grid" || saved === "list") {
        return saved;
      }
    } catch {
      // localStorage unavailable; fall back to default
    }
    return "grid";
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // ignore persistence failures
    }
  }, [view]);
  return [view, setView];
}

function usePersistedSort(): [SortKey, (s: SortKey) => void] {
  const [sort, setSort] = React.useState<SortKey>(() => {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      if (saved && SORT_OPTIONS.some((o) => o.value === saved)) {
        return saved as SortKey;
      }
    } catch {
      // localStorage unavailable; fall back to default
    }
    return "date-desc";
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // ignore persistence failures
    }
  }, [sort]);
  return [sort, setSort];
}

function usePersistedUsage(): [UsageKey, (u: UsageKey) => void] {
  const [usage, setUsage] = React.useState<UsageKey>(() => {
    try {
      const saved = localStorage.getItem(USAGE_KEY);
      if (saved && USAGE_OPTIONS.some((o) => o.value === saved)) {
        return saved as UsageKey;
      }
    } catch {
      // localStorage unavailable; fall back to default
    }
    return "all";
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(USAGE_KEY, usage);
    } catch {
      // ignore persistence failures
    }
  }, [usage]);
  return [usage, setUsage];
}

function AssetMedia({ asset }: { asset: LibraryAsset }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const box: React.CSSProperties = {
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: 4,
    overflow: "hidden",
    background: "#000",
  };

  // Always preview the video itself (never a static poster), playing on hover. Use the original
  // rendition since every asset has one; the poster is only the paused-state placeholder.
  const src = asset.renditions.find((r) => r.quality === "original")?.url ?? asset.renditions[0]?.url;
  return (
    <div style={box}>
      {src && (
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          poster={asset.poster ?? undefined}
          onMouseEnter={() => videoRef.current?.play().catch(() => {})}
          onMouseLeave={() => {
            const v = videoRef.current;
            if (v) {
              v.pause();
              v.currentTime = 0;
            }
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
    </div>
  );
}

const clickable = (open: () => void) => ({
  role: "button" as const,
  tabIndex: 0,
  onClick: open,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  },
  style: { cursor: "pointer" as const },
});

function UseButton({ asset, busy, onSelect }: { asset: LibraryAsset; busy: boolean; onSelect: (a: LibraryAsset) => void }) {
  return (
    <Button
      text={busy ? "Linking…" : "Use this video"}
      tone="primary"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(asset);
      }}
    />
  );
}

function AssetCard({ asset, onSelect, busy, onOpenDetails }: ItemProps) {
  const meta = [formatBytes(asset.bytes), formatDate(asset.updatedAt)].filter(Boolean).join(" · ");

  return (
    <Card border radius={2} padding={2} tone="default" {...clickable(() => onOpenDetails(asset))}>
      <Stack gap={3}>
        <AssetMedia asset={asset} />
        <Stack gap={2} paddingX={1}>
          <Text size={1} weight="semibold" textOverflow="ellipsis" title={asset.name}>
            {asset.name}
          </Text>
          <Flex gap={1} wrap="wrap">
            {asset.usedBy === 0 && (
              <Badge tone="caution" fontSize={0}>
                Unused
              </Badge>
            )}
            {asset.renditions.map((r) => (
              <Badge key={r.url} tone="default" fontSize={0}>
                {qualityLabel(r.quality)}
              </Badge>
            ))}
          </Flex>
          {meta && (
            <Text size={0} muted>
              {meta}
            </Text>
          )}
        </Stack>
        {onSelect && <UseButton asset={asset} busy={busy} onSelect={onSelect} />}
      </Stack>
    </Card>
  );
}

function AssetRow({ asset, onSelect, busy, onOpenDetails }: ItemProps) {
  const qualities = asset.renditions.map((r) => qualityLabel(r.quality)).join(" · ");
  const meta = [qualities, formatBytes(asset.bytes), formatDate(asset.updatedAt)].filter(Boolean).join(" · ");

  return (
    <Card border radius={2} padding={2} tone="default" {...clickable(() => onOpenDetails(asset))}>
      <Flex align="center" gap={3}>
        <Box style={{ width: 96, flex: "none" }}>
          <AssetMedia asset={asset} />
        </Box>
        <Stack gap={2} flex={1} style={{ minWidth: 0 }}>
          <Flex align="center" gap={2} style={{ minWidth: 0 }}>
            <Text size={1} weight="semibold" textOverflow="ellipsis" title={asset.name}>
              {asset.name}
            </Text>
            {asset.usedBy === 0 && (
              <Badge tone="caution" fontSize={0} style={{ flex: "none" }}>
                Unused
              </Badge>
            )}
          </Flex>
          <Text size={0} muted textOverflow="ellipsis">
            {meta}
          </Text>
        </Stack>
        {onSelect && (
          <Box style={{ flex: "none" }}>
            <UseButton asset={asset} busy={busy} onSelect={onSelect} />
          </Box>
        )}
      </Flex>
    </Card>
  );
}

function emptyMessage(total: number, usage: UsageKey) {
  if (!total) {
    return "No videos in the bucket yet. Upload one from a video field.";
  }
  if (usage === "unused") {
    return "No unused videos. Every video in the bucket is in use.";
  }
  if (usage === "used") {
    return "No videos are in use.";
  }
  return "No videos match your search.";
}

export function VideoGrid({ assets, loading, error, usageError, onReload, onSelect, busyId, columns = [1, 2, 3] }: Props) {
  const [query, setQuery] = React.useState("");
  const [detail, setDetail] = React.useState<LibraryAsset | null>(null);
  const [view, setView] = usePersistedView();
  const [sort, setSort] = usePersistedSort();
  const [usage, setUsage] = usePersistedUsage();

  const unusedCount = React.useMemo(() => assets.filter((a) => a.usedBy === 0).length, [assets]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (usage === "used" && !a.usedBy) {
        return false;
      }
      if (usage === "unused" && a.usedBy !== 0) {
        return false;
      }
      if (q && !a.name.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [assets, query, usage]);

  const sorted = React.useMemo(() => {
    const list = [...filtered];
    switch (sort) {
      case "name-asc":
        return list.sort((a, b) => a.name.localeCompare(b.name));
      case "name-desc":
        return list.sort((a, b) => b.name.localeCompare(a.name));
      case "date-asc":
        return list.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
      default:
        return list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    }
  }, [filtered, sort]);

  return (
    <Stack gap={4}>
      <Flex align="center" gap={2}>
        <Box flex={1}>
          <TextInput
            icon={SearchIcon}
            placeholder="Search videos…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            clearButton={Boolean(query)}
            onClear={() => setQuery("")}
          />
        </Box>
        <Text size={1} muted style={{ flex: "none" }}>
          {filtered.length} of {assets.length}
          {unusedCount > 0 && ` · ${unusedCount} unused`}
        </Text>
        <MenuButton
          id="video-library-usage"
          button={
            <Button
              icon={FilterIcon}
              mode="bleed"
              tone={usage === "unused" ? "caution" : "default"}
              text={USAGE_OPTIONS.find((o) => o.value === usage)?.label ?? "All videos"}
            />
          }
          popover={{ portal: true }}
          menu={
            <Menu>
              {USAGE_OPTIONS.map((o) => (
                <MenuItem key={o.value} text={o.label} selected={o.value === usage} onClick={() => setUsage(o.value)} />
              ))}
            </Menu>
          }
        />
        <MenuButton
          id="video-library-sort"
          button={<Button icon={SortIcon} mode="bleed" text={SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Sort"} />}
          popover={{ portal: true }}
          menu={
            <Menu>
              {SORT_OPTIONS.map((o) => (
                <MenuItem key={o.value} text={o.label} selected={o.value === sort} onClick={() => setSort(o.value)} />
              ))}
            </Menu>
          }
        />
        <Flex gap={1}>
          <Button
            icon={ThLargeIcon}
            mode="bleed"
            selected={view === "grid"}
            onClick={() => setView("grid")}
            aria-label="Grid view"
          />
          <Button
            icon={ThListIcon}
            mode="bleed"
            selected={view === "list"}
            onClick={() => setView("list")}
            aria-label="List view"
          />
        </Flex>
        <Button icon={RefreshIcon} mode="ghost" text="Refresh" disabled={loading} onClick={onReload} />
      </Flex>

      {usageError && (
        <Card border radius={2} padding={3} tone="caution">
          <Text size={1}>Could not check where videos are used, so none is marked Unused: {usageError}</Text>
        </Card>
      )}

      {error && (
        <Card border radius={2} padding={3} tone="critical">
          <Flex align="center" justify="space-between" gap={3}>
            <Text size={1}>{error}</Text>
            <Button text="Retry" mode="ghost" onClick={onReload} />
          </Flex>
        </Card>
      )}

      {loading && !assets.length ? (
        <Flex align="center" justify="center" padding={5}>
          <Spinner muted />
        </Flex>
      ) : !error && !filtered.length ? (
        <Card border radius={2} padding={4} tone="transparent">
          <Text size={1} muted align="center">
            {emptyMessage(assets.length, usage)}
          </Text>
        </Card>
      ) : view === "grid" ? (
        <Grid gridTemplateColumns={columns} gap={3}>
          {sorted.map((asset) => (
            <AssetCard key={asset.id} asset={asset} onSelect={onSelect} busy={busyId === asset.id} onOpenDetails={setDetail} />
          ))}
        </Grid>
      ) : (
        <Stack gap={2}>
          {sorted.map((asset) => (
            <AssetRow key={asset.id} asset={asset} onSelect={onSelect} busy={busyId === asset.id} onOpenDetails={setDetail} />
          ))}
        </Stack>
      )}

      {detail && (
        <VideoDetailsDialog
          asset={detail}
          onClose={() => setDetail(null)}
          onSelect={onSelect}
          busy={busyId === detail.id}
          onDeleted={() => {
            setDetail(null);
            onReload();
          }}
        />
      )}
    </Stack>
  );
}
