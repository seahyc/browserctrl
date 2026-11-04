// Backward-compatible card API. Card and general transfers use one engine and transport.
import {createTransferGate,submitVaultTransfer} from './vault-transfer.mjs';
export {luhn,parseCard,validCardFields,validateCardCapture,validateCardFill} from './vault-transfer-profiles.mjs';
export function createCardGate(options) {
  const gate = options.transferGate || createTransferGate(options);
  return {capture:gate.captureCard,fill:gate.fillCard};
}
export const submitVaultCard = (request,options = {}) => submitVaultTransfer(request,{...options,legacy:true});
