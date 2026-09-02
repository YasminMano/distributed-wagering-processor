import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  WAGER_PROCESSING_STORE,
} from '../../application/ports/wager-processing.store';
import type { WagerProcessingStore } from '../../application/ports/wager-processing.store';
import { RetryPendingReferenceWagersUseCase } from '../../application/use-cases/retry-pending-reference-wagers.use-case';
import { ObservabilityService } from '../observability/observability.service';

const RETRY_POLL_INTERVAL_MS = 100;

@Injectable()
export class PendingReferenceRetryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly retryUseCase: RetryPendingReferenceWagersUseCase;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(WAGER_PROCESSING_STORE)
    store: WagerProcessingStore,
    private readonly observability: ObservabilityService,
  ) {
    this.retryUseCase =
      new RetryPendingReferenceWagersUseCase(store);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, RETRY_POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async runOnce(now = new Date()): Promise<number> {
    const processed =
      await this.retryUseCase.processDue(now);

    if (processed > 0) {
      this.observability.recordRetry(
        'pendingReference',
        processed,
      );

      this.observability.log(
        'info',
        'pending_reference_retry_batch',
        {},
        {
          processed,
        },
      );
    }

    return processed;
  }
}
