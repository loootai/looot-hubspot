import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Flex, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { BACKEND_URL } from './backend';

export type ActionId = 'find-work-email' | 'verify-email' | 'enrich-company';
type PriceKey = 'findWorkEmail' | 'verifyEmail' | 'enrichCompany';

export type ActionDef = { id: ActionId; label: string; priceKey: PriceKey; summary: string };

type PriceInfo = {
  ok: boolean;
  prices: Record<PriceKey, number>;
  asOf: string;
  source: 'live' | 'fallback';
  hasToken: boolean;
};

type ActionResult = {
  found: boolean;
  skipped: boolean;
  message: string;
  run: { runId: string; costUsd: number; provider: string | null } | null;
  written: { property: string; value: string }[];
  notWritten: { property: string; reason: string }[];
};

type ActionAnswer = { ok: boolean; result?: ActionResult; error?: { code: string; message: string } };

/** Formats a price per call without trailing zeros, for example 0.003598. */
export const formatPrice = (value: number): string => `$${Number(value.toFixed(6)).toString()}`;

/** The price line shown before any call. */
export const priceLine = (info: PriceInfo, key: PriceKey): string => {
  const base = `from ${formatPrice(info.prices[key])} per lookup, cheapest provider on ${info.asOf}`;
  return info.source === 'fallback' ? `${base} (the live catalog could not be read; this is the last known price)` : base;
};

/** Card body shared by the contact and company cards: price, confirm, result. */
export const LoootPanel = ({ objectId, actions }: { objectId: number | string; actions: ActionDef[] }) => {
  const [info, setInfo] = useState<PriceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<ActionAnswer | null>(null);

  const loadPrices = useCallback(async () => {
    try {
      const response = await hubspot.fetch(`${BACKEND_URL}/api/prices`, { method: 'GET' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setInfo((await response.json()) as PriceInfo);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'unknown error');
    }
  }, []);

  useEffect(() => {
    void loadPrices();
  }, [loadPrices]);

  const confirm = async (action: ActionDef) => {
    setRunning(true);
    setAnswer(null);
    try {
      const response = await hubspot.fetch(`${BACKEND_URL}/api/actions/${action.id}`, {
        method: 'POST',
        body: { objectId: String(objectId), confirm: true },
      });
      setAnswer((await response.json()) as ActionAnswer);
    } catch (error) {
      setAnswer({ ok: false, error: { code: 'network', message: error instanceof Error ? error.message : 'The backend did not answer.' } });
    } finally {
      setRunning(false);
      setPending(null);
    }
  };

  if (loadError) {
    return (
      <Alert title="The looot backend did not answer" variant="danger">
        {loadError}. Check that the backend is running and that its address is in the app's permitted URLs.
      </Alert>
    );
  }
  if (!info) return <LoadingSpinner label="Reading prices" />;
  if (!info.hasToken) {
    return (
      <Alert title="Add your looot token first" variant="warning">
        Open Marketplace, Connected apps, looot, Settings, and paste a looot agent token. It is saved for this HubSpot account and never shown again.
      </Alert>
    );
  }

  return (
    <Flex direction="column" gap="small">
      {pending ? (
        <Flex direction="column" gap="small">
          <Text format={{ fontWeight: 'bold' }}>{pending.label}</Text>
          <Text>{pending.summary}</Text>
          <Text>This lookup costs {priceLine(info, pending.priceKey)}. The real charge is shown after the run.</Text>
          <Flex direction="row" gap="small">
            <Button variant="primary" disabled={running} onClick={() => void confirm(pending)}>
              {running ? 'Running' : 'Confirm and run'}
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </Flex>
        </Flex>
      ) : (
        <Flex direction="column" gap="small">
          {actions.map((action) => (
            <Flex key={action.id} direction="column" gap="flush">
              <Button variant="secondary" onClick={() => { setAnswer(null); setPending(action); }}>
                {action.label}
              </Button>
              <Text variant="microcopy">{priceLine(info, action.priceKey)}</Text>
            </Flex>
          ))}
        </Flex>
      )}
      {answer ? <Divider /> : null}
      {answer && !answer.ok ? (
        <Alert title="The lookup did not run" variant="danger">
          {answer.error?.message ?? 'Unknown error.'}
        </Alert>
      ) : null}
      {answer?.ok && answer.result ? <ResultView result={answer.result} /> : null}
    </Flex>
  );
};

const ResultView = ({ result }: { result: ActionResult }) => (
  <Flex direction="column" gap="extra-small">
    <Alert title={result.message} variant={result.found ? 'success' : 'info'}>
      {result.run
        ? `Provider ${result.run.provider ?? 'unknown'}. Cost ${formatPrice(result.run.costUsd)}. Run ${result.run.runId}.`
        : 'Nothing was called and nothing was charged.'}
    </Alert>
    {result.written.length > 0 ? (
      <Text>Written to the record: {result.written.map((w) => `${w.property} = ${w.value}`).join(', ')}</Text>
    ) : null}
    {result.notWritten.map((n) => (
      <Text key={n.property} variant="microcopy">
        Not written, {n.property}: {n.reason}
      </Text>
    ))}
  </Flex>
);
