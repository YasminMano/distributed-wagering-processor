#!/usr/bin/env bash
set -euo pipefail

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

ENDPOINT="http://localhost:4566"
REGION="us-east-1"

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"

echo "Creating SQS queues..."

DLQ_URL="$(
  aws --endpoint-url="$ENDPOINT" sqs create-queue \
    --queue-name "$DLQ_NAME" \
    --attributes '{
      "FifoQueue": "true",
      "ContentBasedDeduplication": "true"
    }' \
    --region "$REGION" \
    --query QueueUrl \
    --output text
)"

DLQ_ARN="$(
  aws --endpoint-url="$ENDPOINT" sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn \
    --region "$REGION" \
    --query 'Attributes.QueueArn' \
    --output text
)"

aws --endpoint-url="$ENDPOINT" sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" \
  --region "$REGION"

echo "SQS queues ready."


EVENT_QUEUE_NAME="wager-events.fifo"

aws --endpoint-url="$ENDPOINT" sqs create-queue \
  --queue-name "$EVENT_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  --region "$REGION"

echo "Event queue ready."
