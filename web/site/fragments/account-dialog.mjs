// The account panel's dialogs, for a page's `overlays`.
//
//   import { ACCOUNT_SCRIPTS, ACCOUNT_STYLES, accountDialog } from '../fragments/account-dialog.mjs';
//
//   export default {
//     path: '/',
//     styles: [...ACCOUNT_STYLES, '/css/workbench.css'],
//     scripts: [...ACCOUNT_SCRIPTS, '/app/workbench.mjs'],
//     overlays: accountDialog(),
//     …
//   };
//
// The three dialogs are empty shells: /app/account.mjs fills them when they
// open, because what they show depends on who is signed in.
//
//   #account-dialog   sign-in and account creation (480px)
//   #portal-dialog    the signed-in account sheet: Overview, Reviews, Connections, Security, Billing
//   #reauth-dialog    "Confirm it's you", the passkey check before a credential change
//
// A page that loads /app/account.mjs without this fragment still works: the
// script creates the dialogs and links /css/account.css itself. The fragment
// saves that work and keeps the stylesheet in the page's head.
//
// What a page can mark up for the script (no code needed on the page):
//
//   <button data-account-action="open">            open the panel
//   <button data-account-action="signin" data-account-reason="review">   the sign-in dialog with a reason
//   <button data-account-action="checkout">        start Operator checkout (signs in first when needed)
//   <button data-account-action="billing">         open the Stripe customer portal
//   <div data-checkout-note></div>                 where "Checkout closed. Nothing was charged." appears
//                                                  after ?checkout=cancelled; without it, the line goes under
//                                                  the heading of #pricing
//
// The header's #account-button and any link to /#account open the panel.

import { dialog, html } from '../components.mjs';

/** Stylesheets a page with the account panel lists after base.css. */
export const ACCOUNT_STYLES = ['/css/account.css'];

/** Module scripts a page with the account panel loads. */
export const ACCOUNT_SCRIPTS = ['/app/account.mjs'];

/** The three dialog shells. Put the result in the page's `overlays`. */
export function accountDialog() {
  return html`${dialog({ id: 'account-dialog', title: 'Sign in', size: 'sm', className: 'account-dialog', body: '' })}
${dialog({ id: 'portal-dialog', title: 'Account', size: 'lg', className: 'portal', body: '' })}
${dialog({ id: 'reauth-dialog', title: "Confirm it's you", size: 'sm', className: 'reauth-dialog', body: '' })}`;
}

export default accountDialog;
