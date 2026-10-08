import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import { type ActionDef, LoootPanel } from './LoootPanel';

const ACTIONS: ActionDef[] = [
  {
    id: 'find-work-email',
    label: 'Find work email',
    priceKey: 'findWorkEmail',
    summary: 'Looks up this contact by name and company. The email is written only when the contact has none.',
  },
  {
    id: 'verify-email',
    label: 'Verify email',
    priceKey: 'verifyEmail',
    summary: "Checks that this contact's email can receive mail. The status goes to the looot email status property when it is empty.",
  },
];

hubspot.extend<'crm.record.tab'>(({ context }) => <LoootPanel objectId={context.crm.objectId} actions={ACTIONS} />);
