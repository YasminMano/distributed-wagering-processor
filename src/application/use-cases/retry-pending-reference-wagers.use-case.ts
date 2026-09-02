import { WagerProcessingStore } from '../ports/wager-processing.store';
import { ProcessWagerUseCase } from './process-wager.use-case';

export class RetryPendingReferenceWagersUseCase {
  private readonly processor: ProcessWagerUseCase;

  constructor(
    private readonly store: WagerProcessingStore,
  ) {
    this.processor = new ProcessWagerUseCase(store);
  }

  async processDue(now: Date): Promise<number> {
    const transactionIds =
      await this.store.execute((unitOfWork) =>
        unitOfWork.findDuePendingReferenceTransactionIds(now),
      );

    let processed = 0;

    for (const transactionId of transactionIds) {
      const result =
        await this.processor.retryPendingReference(
          transactionId,
          now,
        );

      if (result) {
        processed += 1;
      }
    }

    return processed;
  }
}
