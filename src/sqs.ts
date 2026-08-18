/**
 * Payload sent to SQS to process a matched GitHub Actions workflow artifact.
 */
export interface ProcessArtifactMessage {
	installationId?: number;
	repository: {
		name: string;
		full_name: string;
		private: boolean;
		owner: {
			login: string;
		};
	};
	workflowRun: {
		id: number;
		name: string | null;
		path: string;
		head_sha: string;
	};
	artifact: {
		id: number;
		name: string;
	};
}
