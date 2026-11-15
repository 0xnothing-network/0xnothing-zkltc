/**
 * src/core/rpc/client.ts builds its clients as viem's createClient(options)
 * .extend(actions), with the type createPublicClient / createWalletClient would
 * set. Tests keep their read and signing doubles under the old names; this hands
 * each client's options to the matching double.
 */
export function withCreateClient<T extends {
  createPublicClient: (options: never) => unknown;
  createWalletClient: (options: never) => unknown;
}>(viem: T): T & { createClient: (options: { type?: string }) => { extend: () => unknown } } {
  return {
    ...viem,
    createClient: (options: { type?: string }) => ({
      extend: () => (options.type === "walletClient"
        ? viem.createWalletClient(options as never)
        : viem.createPublicClient(options as never)),
    }),
  };
}
