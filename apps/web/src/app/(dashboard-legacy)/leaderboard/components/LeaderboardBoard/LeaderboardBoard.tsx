"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import type { LeaderboardPeriod } from "@superset/trpc/leaderboard-periods";
import type {
	LeaderboardMetric,
	StandingRow,
} from "@superset/trpc/leaderboard-types";
import { Button } from "@superset/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/react";
import {
	formatDayRange,
	formatTokens,
	formatUsd,
} from "../../utils/formatUsage";
import { LeaderboardTable } from "./components/LeaderboardTable";

const PAGE_SIZE = 50;
const PERIODS = [
	"7d",
	"30d",
	"all",
] as const satisfies readonly LeaderboardPeriod[];
type BoardPeriod = (typeof PERIODS)[number];

export function LeaderboardBoard() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { t } = useLingui();
	const [metric, setMetric] = useState<LeaderboardMetric>("tokens");
	const [period, setPeriod] = useState<BoardPeriod>("30d");
	const [extraRows, setExtraRows] = useState<StandingRow[]>([]);
	const [loadingMore, setLoadingMore] = useState(false);

	const standings = useQuery(
		trpc.leaderboard.standings.queryOptions({
			period,
			metric,
			limit: PAGE_SIZE,
		}),
	);
	const stats = useQuery(
		trpc.leaderboard.public.stats.queryOptions({ period }),
	);

	const rows = [...(standings.data?.rows ?? []), ...extraRows];
	const total = standings.data?.total ?? 0;
	const range = standings.data?.range ?? null;
	const totals = stats.data?.totals;
	const cachedShare =
		totals && totals.tokens > 0
			? Math.round(
					((stats.data?.tokenSplit.cachedInput ?? 0) / totals.tokens) * 100,
				)
			: 0;

	const select = (next: {
		metric?: LeaderboardMetric;
		period?: BoardPeriod;
	}) => {
		setExtraRows([]);
		if (next.metric) setMetric(next.metric);
		if (next.period) setPeriod(next.period);
	};

	const loadMore = async () => {
		if (loadingMore) return;
		setLoadingMore(true);
		try {
			const next = await queryClient.fetchQuery(
				trpc.leaderboard.standings.queryOptions({
					period,
					metric,
					limit: PAGE_SIZE,
					offset: rows.length,
				}),
			);
			setExtraRows((current) => [...current, ...next.rows]);
		} finally {
			setLoadingMore(false);
		}
	};

	return (
		<div className="space-y-6">
			{totals && (
				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					<Stat
						label={t({
							id: "web.leaderboard.stats.developers",
							message: "Developers",
						})}
						value={String(totals.participants)}
					/>
					<Stat
						label={t({ id: "web.leaderboard.stats.tokens", message: "Tokens" })}
						value={formatTokens(totals.tokens)}
					/>
					<Stat
						label={t({ id: "web.leaderboard.stats.cost", message: "Cost" })}
						value={formatUsd(totals.usd)}
						hint={t({
							id: "web.leaderboard.stats.costHint",
							message: "API-equivalent",
						})}
					/>
					<Stat
						label={t({
							id: "web.leaderboard.stats.cacheRead",
							message: "Cache read",
						})}
						value={`${cachedShare}%`}
						hint={t({
							id: "web.leaderboard.stats.cacheReadHint",
							message: "of all tokens",
						})}
					/>
				</dl>
			)}

			<div className="flex flex-wrap items-center gap-4">
				<Tabs
					value={metric}
					onValueChange={(value) =>
						select({ metric: value as LeaderboardMetric })
					}
				>
					<TabsList
						aria-label={t({
							id: "web.leaderboard.metric.ariaLabel",
							message: "Rank by",
						})}
					>
						<TabsTrigger value="tokens">
							<Trans id="web.leaderboard.metric.tokens">Tokens</Trans>
						</TabsTrigger>
						<TabsTrigger value="cost">
							<Trans id="web.leaderboard.metric.cost">Cost</Trans>
						</TabsTrigger>
					</TabsList>
				</Tabs>
				<Tabs
					value={period}
					onValueChange={(value) => select({ period: value as BoardPeriod })}
				>
					<TabsList
						aria-label={t({
							id: "web.leaderboard.range.ariaLabel",
							message: "Date range",
						})}
					>
						<TabsTrigger value="7d">
							<Trans id="web.leaderboard.range.7d">7D</Trans>
						</TabsTrigger>
						<TabsTrigger value="30d">
							<Trans id="web.leaderboard.range.30d">30D</Trans>
						</TabsTrigger>
						<TabsTrigger value="all">
							<Trans id="web.leaderboard.range.all">All</Trans>
						</TabsTrigger>
					</TabsList>
				</Tabs>
				<span className="font-mono text-xs text-muted-foreground">
					{range ? (
						formatDayRange(range)
					) : (
						<Trans id="web.leaderboard.range.allTime">All time</Trans>
					)}
				</span>
			</div>

			{standings.isError ? (
				<p className="text-sm text-destructive">
					<Trans id="web.leaderboard.error">
						Could not load the leaderboard.
					</Trans>
				</p>
			) : (
				<LeaderboardTable
					rows={rows}
					metric={metric}
					isLoading={standings.isPending}
				/>
			)}

			{total > rows.length && (
				<div className="flex flex-col items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={loadMore}
						disabled={loadingMore}
					>
						{loadingMore ? (
							<Trans id="web.leaderboard.loading">Loading…</Trans>
						) : (
							<Trans id="web.leaderboard.loadMore">Load more</Trans>
						)}
					</Button>
					<span className="font-mono text-xs text-muted-foreground">
						<Trans id="web.leaderboard.shownOfTotal">
							{rows.length} of {total}
						</Trans>
					</span>
				</div>
			)}
		</div>
	);
}

function Stat({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<div className="rounded-md border p-4">
			<dt className="text-xs uppercase tracking-wider text-muted-foreground">
				{label}
			</dt>
			<dd className="mt-1 font-mono text-xl">{value}</dd>
			{hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
		</div>
	);
}
