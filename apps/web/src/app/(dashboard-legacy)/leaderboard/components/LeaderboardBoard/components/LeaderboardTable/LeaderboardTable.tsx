"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import type { Tier } from "@superset/trpc/leaderboard-tier";
import { tierName } from "@superset/trpc/leaderboard-tier";
import type {
	LeaderboardMetric,
	StandingRow,
} from "@superset/trpc/leaderboard-types";
import { Skeleton } from "@superset/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@superset/ui/table";
import {
	formatCount,
	formatTokens,
	formatUsd,
} from "../../../../utils/formatUsage";

interface LeaderboardTableProps {
	rows: StandingRow[];
	metric: LeaderboardMetric;
	isLoading?: boolean;
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"];

export function LeaderboardTable({
	rows,
	metric,
	isLoading,
}: LeaderboardTableProps) {
	const { t } = useLingui();

	if (isLoading) {
		return (
			<div className="space-y-2">
				{SKELETON_KEYS.map((key) => (
					<Skeleton key={key} className="h-12 w-full" />
				))}
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className="rounded-md border p-12 text-center">
				<p className="text-sm text-muted-foreground">
					<Trans id="web.leaderboard.empty.title">
						Nobody has joined the board yet.
					</Trans>
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					<Trans id="web.leaderboard.empty.optIn">
						Opt in from the Superset desktop app under Settings → Account.
					</Trans>
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-md border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-14">#</TableHead>
						<TableHead>
							<Trans id="web.leaderboard.column.developer">Developer</Trans>
						</TableHead>
						<TableHead className="hidden md:table-cell">
							<Trans id="web.leaderboard.column.tier">Tier</Trans>
						</TableHead>
						<TableHead className="hidden text-right sm:table-cell">
							<Trans id="web.leaderboard.column.sessions">Sessions</Trans>
						</TableHead>
						<TableHead className="text-right">
							{metric === "cost" ? (
								<Trans id="web.leaderboard.column.cost">Cost</Trans>
							) : (
								<Trans id="web.leaderboard.column.tokens">Tokens</Trans>
							)}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const tier = tierName(row.tier as Tier);
						return (
							<TableRow key={row.handle}>
								<TableCell className="font-mono text-muted-foreground">
									{row.rank}
								</TableCell>
								<TableCell>
									{row.name ? (
										<div className="min-w-0">
											<div className="truncate text-sm">{row.name}</div>
											<div className="truncate font-mono text-xs text-muted-foreground">
												@{row.handle}
											</div>
										</div>
									) : (
										<div className="truncate font-mono text-sm">
											@{row.handle}
										</div>
									)}
								</TableCell>
								<TableCell className="hidden text-sm text-muted-foreground md:table-cell">
									{tier ??
										t({
											id: "web.leaderboard.tier.unranked",
											message: "Unranked",
										})}
								</TableCell>
								<TableCell className="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell">
									{formatCount(row.sessions)}
								</TableCell>
								<TableCell className="text-right font-mono text-sm">
									{metric === "cost"
										? formatUsd(row.usd)
										: formatTokens(row.tokens)}
									{row.approximate && (
										<span
											className="ml-1 text-muted-foreground"
											title={t({
												id: "web.leaderboard.approximateHint",
												message: "Some models were priced with a fallback rate",
											})}
										>
											*
										</span>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
