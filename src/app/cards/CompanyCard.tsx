import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import { type ActionDef, LoootPanel } from './LoootPanel';

const ACTIONS: ActionDef[] = [
  {
    id: 'enrich-company',
    label: 'Enrich company with looot',
    priceKey: 'enrichCompany',
    summary: 'Looks up this company by domain or name. Industry and size go to the looot properties, empty ones only.',
  },
];

hubspot.extend<'crm.record.tab'>(({ context }) => <LoootPanel objectId={context.crm.objectId} actions={ACTIONS} />);
