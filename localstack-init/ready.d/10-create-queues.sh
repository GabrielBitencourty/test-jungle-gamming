#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null
DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
REDRIVE="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")"
REDRIVE_ESCAPED="$(printf '%s' "$REDRIVE" | sed 's/\\/\\\\/g; s/"/\\"/g')"
ATTRIBUTES_FILE="/tmp/wager-transaction-queue-attributes.json"
printf '{"FifoQueue":"true","ContentBasedDeduplication":"true","VisibilityTimeout":"30","RedrivePolicy":"%s"}' \
  "$REDRIVE_ESCAPED" > "$ATTRIBUTES_FILE"
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "file://$ATTRIBUTES_FILE" >/dev/null
awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null
