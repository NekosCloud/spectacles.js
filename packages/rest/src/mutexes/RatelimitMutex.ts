import type { AbortSignal } from 'node-fetch';
import { InternalError } from '../structures/HTTPError';
import { pause } from '../util';

export interface Ratelimit {
	global: boolean;
	limit: number;
	timeout: number;
	remaining: number;
}

export default abstract class RatelimitMutex {
	public claim(route: string, signal?: AbortSignal | null): Promise<void> {
		return new Promise(async (resolve, reject) => {
			const listener = () => reject(new Error(InternalError.REQUEST_CANCELLED));
			if (signal) signal.addEventListener('abort', listener);

			try {
				// keep checking for a timeout while we don't have 0 and the request isn't aborted
				let timeout = await this.getTimeout(route);
				while (timeout > 0 && !signal?.aborted) {
					await pause(timeout);
					timeout = await this.getTimeout(route);
				}
			} catch (e) {
				reject(e);
				return;
			}

			if (signal) signal.removeEventListener('abort', listener)
			resolve();
		});

	}

	public abstract set(route: string, limits: Partial<Ratelimit>): Promise<void>;
	protected abstract getTimeout(route: string): Promise<number>;
}
