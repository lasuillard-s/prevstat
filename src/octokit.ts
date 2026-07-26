/** Minimal shape of a Probot event context needed to derive the current repository. */
interface ContextRepoProvider {
	repo: () => { owner: string; repo: string };
}

export class Repo {
	constructor(
		public readonly owner: string,
		public readonly repo: string
	) {}

	/**
	 * Parses a repository full name in `owner/repo` format into a Repo.
	 * @param fullName Repository full name
	 * @returns The parsed Repo
	 */
	static fromFullName(fullName: string): Repo {
		const [owner, repo] = fullName.split('/');
		return new Repo(owner, repo);
	}

	/**
	 * Creates a Repo from a Probot event context.
	 * @param context Event context that exposes the repository helper
	 * @returns The Repo for the event's repository
	 */
	static fromContext(context: ContextRepoProvider): Repo {
		const { owner, repo } = context.repo();
		return new Repo(owner, repo);
	}

	/**
	 * Returns the `owner/repo` full name of the repository.
	 * @returns The full name in `owner/repo` format
	 */
	toFullName(): string {
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
