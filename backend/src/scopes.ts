/** Scopes the install must grant. Kept equal to src/app/app-hsmeta.json by a test. */
export const REQUIRED_SCOPES = ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.companies.read', 'crm.objects.companies.write'];

/** Scopes the account may decline. Without them the app cannot create its three custom properties. */
export const OPTIONAL_SCOPES = ['crm.schemas.contacts.write', 'crm.schemas.companies.write'];
