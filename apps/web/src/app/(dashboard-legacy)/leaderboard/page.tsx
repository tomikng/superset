import { Trans } from "@lingui/react/macro";
import { LeaderboardBoard } from "./components/LeaderboardBoard";

export default function LeaderboardPage() {
	return (
		<div className="space-y-8">
			<div>
				<h2 className="text-xl font-medium">
					<Trans id="web.leaderboard.title">Leaderboard</Trans>
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					<Trans id="web.leaderboard.tagline">
						Agent usage, ranked. Token counts and model names only, published by
						people who opted in.
					</Trans>
				</p>
			</div>
			<LeaderboardBoard />
		</div>
	);
}
