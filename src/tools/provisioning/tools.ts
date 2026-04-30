// Backwards-compatible alias for the provisioning adapter.
import { ProvisioningAdapter as ProvisioningAdapterImpl } from "../../provisioning/adapter.js";
import { provisioningTools as provisioningToolsImpl } from "../../provisioning/index.js";

export const ProvisioningAdapter = ProvisioningAdapterImpl;
export const provisioningTools = provisioningToolsImpl;
