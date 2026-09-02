import { Injectable } from '@nestjs/common';

type LogLevel = 'info' | 'warn' | 'error';

export interface ObservabilityContext {
  correlationId?: string | null;
  messageId?: string | null;
  transactionId?: string | null;
  walletId?: string | null;
  providerId?: string | null;
}

type LogDetails = Record<
  string,
  string | number | boolean | null
>;

@Injectable()
export class ObservabilityService {
  private duplicatesDetected = 0;
  private outboxRetries = 0;
  private pendingReferenceRetries = 0;
  private lockConflicts = 0;
  private reconciliationDivergences = 0;
  private latencyCount = 0;
  private latencyTotalMs = 0;
  private latencyMaxMs = 0;

  recordDuplicate(): void {
    this.duplicatesDetected += 1;
  }

  recordRetry(
    kind: 'outbox' | 'pendingReference',
    count = 1,
  ): void {
    if (kind === 'outbox') {
      this.outboxRetries += count;
      return;
    }

    this.pendingReferenceRetries += count;
  }

  recordProcessingLatency(latencyMs: number): void {
    const normalized = Math.max(0, latencyMs);

    this.latencyCount += 1;
    this.latencyTotalMs += normalized;
    this.latencyMaxMs = Math.max(
      this.latencyMaxMs,
      normalized,
    );
  }

  recordLockConflictFrom(error: unknown): boolean {
    const code = this.findErrorCode(error);

    if (
      code === '40P01' ||
      code === '55P03' ||
      code === '57014'
    ) {
      this.lockConflicts += 1;
      return true;
    }

    return false;
  }

  recordReconciliationDivergence(): void {
    this.reconciliationDivergences += 1;
  }

  processMetrics(): Record<string, unknown> {
    return {
      duplicatesDetected: this.duplicatesDetected,
      reconciliationDivergences:
        this.reconciliationDivergences,
      retries: {
        outbox: this.outboxRetries,
        pendingReference:
          this.pendingReferenceRetries,
      },
      lockConflicts: this.lockConflicts,
      processingLatencyMs: {
        count: this.latencyCount,
        total: this.latencyTotalMs,
        average:
          this.latencyCount === 0
            ? 0
            : Number(
                (
                  this.latencyTotalMs /
                  this.latencyCount
                ).toFixed(2),
              ),
        max: this.latencyMaxMs,
      },
    };
  }

  log(
    level: LogLevel,
    event: string,
    context: ObservabilityContext = {},
    details: LogDetails = {},
  ): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      correlationId: context.correlationId ?? null,
      messageId: context.messageId ?? null,
      transactionId:
        context.transactionId ?? null,
      walletId: context.walletId ?? null,
      providerId: context.providerId ?? null,
      ...details,
    });

    if (level === 'error') {
      console.error(line);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  private findErrorCode(
    error: unknown,
    depth = 0,
  ): string | undefined {
    if (
      depth > 4 ||
      typeof error !== 'object' ||
      error === null
    ) {
      return undefined;
    }

    const candidate = error as {
      code?: unknown;
      cause?: unknown;
      driverException?: unknown;
      originalError?: unknown;
    };

    if (typeof candidate.code === 'string') {
      return candidate.code;
    }

    return (
      this.findErrorCode(candidate.cause, depth + 1) ??
      this.findErrorCode(
        candidate.driverException,
        depth + 1,
      ) ??
      this.findErrorCode(
        candidate.originalError,
        depth + 1,
      )
    );
  }
}
