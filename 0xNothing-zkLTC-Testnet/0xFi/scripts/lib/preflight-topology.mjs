const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function normalizedAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} is not a valid address`);
  }
  return value.toLowerCase();
}

export function pumpAdministrationTopology({
  account,
  pump,
  router,
  pumpAdmin,
  routerAdmin,
  deployment = {},
  controllerState,
}) {
  const accountAddress = normalizedAddress(account, "configured deployer");
  const pumpAddress = normalizedAddress(pump, "Pump");
  const routerAddress = normalizedAddress(router, "graduation router");
  const livePumpAdmin = normalizedAddress(pumpAdmin, "Pump admin");
  const liveRouterAdmin = normalizedAddress(routerAdmin, "graduation router admin");
  const status = deployment.pumpAdministrationStatus;

  if (status === "controller-admin-active") {
    const controller = normalizedAddress(
      deployment.contracts?.pumpGraduationController,
      "recorded graduation controller",
    );
    const adapter = normalizedAddress(
      deployment.contracts?.pumpGraduationAdapter,
      "recorded graduation adapter",
    );
    const governance = normalizedAddress(deployment.governance, "controller governance");
    const guardian = normalizedAddress(deployment.guardian, "controller guardian");

    if (livePumpAdmin !== controller || liveRouterAdmin !== controller) {
      throw new Error("Controller-admin manifest does not match the live Pump and GraduationRouter admins");
    }
    if (!controllerState || typeof controllerState !== "object") {
      throw new Error("Controller-admin topology could not be read");
    }
    for (const [actual, expected, label] of [
      [controllerState.pump, pumpAddress, "Pump"],
      [controllerState.router, routerAddress, "graduation router"],
      [controllerState.adapter, adapter, "graduation adapter"],
      [controllerState.governance, governance, "governance"],
      [controllerState.guardian, guardian, "guardian"],
    ]) {
      if (normalizedAddress(actual, `controller ${label}`) !== expected) {
        throw new Error(`Graduation controller ${label} binding mismatch`);
      }
    }
    if (accountAddress !== governance) {
      throw new Error("Configured deployer is not the active graduation controller governance");
    }
    return {
      mode: "controller",
      status,
      expectedAdmin: deployment.contracts.pumpGraduationController,
    };
  }

  if (status !== undefined && status !== null && status !== "") {
    throw new Error(`Unsupported Pump administration status: ${status}`);
  }
  if (livePumpAdmin !== accountAddress || liveRouterAdmin !== accountAddress) {
    throw new Error("Configured deployer is not the live 0xPump and GraduationRouter admin");
  }
  return { mode: "direct-eoa", status: "unrecorded-direct-admin", expectedAdmin: account };
}
