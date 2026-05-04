// ============================================================
// vClaw — QA Canary Teardown
// Terminates the AWS canary EC2 instance and deletes the
// Azure resource group provisioned by provision-qa-canaries.ts.
// ============================================================

import "dotenv/config";
import { ClientSecretCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

const AZURE_SUBSCRIPTION = "23e4afd3-0c4d-4b76-b460-e43f196052fd";
const AZURE_RG = "vclaw-qa";
const AWS_REGION = "us-east-2";
const CANARY_NAME = "vclaw-qa-canary";

async function teardownAws(): Promise<void> {
  const ec2 = new EC2Client({ region: AWS_REGION });

  const desc = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: "tag:Name", Values: [CANARY_NAME] }],
    }),
  );

  const ids =
    desc.Reservations?.flatMap(
      (r) =>
        r.Instances?.filter(
          (i) => i.State?.Name !== "terminated" && i.InstanceId,
        ).map((i) => i.InstanceId!) ?? [],
    ) ?? [];

  if (ids.length === 0) {
    console.log("[AWS] no canary instances found to terminate");
    return;
  }

  console.log(`[AWS] terminating ${ids.length} instance(s): ${ids.join(", ")}`);
  const result = await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
  for (const change of result.TerminatingInstances ?? []) {
    console.log(
      `[AWS] ${change.InstanceId}: ${change.PreviousState?.Name} -> ${change.CurrentState?.Name}`,
    );
  }
}

async function teardownAzure(): Promise<void> {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
  const resources = new ResourceManagementClient(credential, AZURE_SUBSCRIPTION);

  const exists = await resources.resourceGroups
    .checkExistence(AZURE_RG)
    .then((r) => r.body ?? false)
    .catch(() => false);

  if (!exists) {
    console.log(`[Azure] resource group ${AZURE_RG} does not exist`);
    return;
  }

  console.log(`[Azure] deleting resource group ${AZURE_RG} (async, returns immediately)`);
  // beginDelete returns a poller; we don't await its completion — the user
  // wants money to stop bleeding fast, and the request itself signals Azure
  // to start tearing down all resources in the RG (VM, NIC, disk, IP, NSG).
  await resources.resourceGroups.beginDelete(AZURE_RG);
  console.log(`[Azure] delete request accepted for ${AZURE_RG}`);
}

async function main(): Promise<void> {
  await Promise.allSettled([teardownAws(), teardownAzure()]);
  console.log("done");
}

main().catch((err) => {
  console.error("teardown failed:", err);
  process.exit(1);
});
