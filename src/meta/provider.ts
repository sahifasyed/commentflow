import { decryptSecret } from "../lib/crypto.js";
import { GraphInstagramApi, type InstagramApi } from "./api.js";
import { DemoInstagramApi } from "./demo.js";

export interface AccountForApi {
  id: string;
  ig_user_id: string;
  is_demo: boolean;
  access_token_enc: string | null;
}

type Factory = (account: AccountForApi) => InstagramApi;

const defaultFactory: Factory = (account) => {
  if (account.is_demo) return new DemoInstagramApi(account.id);
  if (!account.access_token_enc) throw new Error("Account has no access token");
  return new GraphInstagramApi(account.ig_user_id, decryptSecret(account.access_token_enc));
};

let factory: Factory = defaultFactory;

export function getInstagramApi(account: AccountForApi): InstagramApi {
  return factory(account);
}

/** Test hook. Pass null to restore the default. */
export function setInstagramApiFactory(f: Factory | null) {
  factory = f ?? defaultFactory;
}
