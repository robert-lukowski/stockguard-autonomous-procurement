import { readFileSync } from "node:fs";

const workflow = readFileSync(
  ".github/workflows/aws-readonly-inventory.yml",
  "utf8",
);
const template = readFileSync(
  "infrastructure/bootstrap/github-readonly-role.yml",
  "utf8",
);
const inventory = readFileSync(
  "scripts/aws-readonly-inventory.sh",
  "utf8",
);

function requireMatch(value, expression, message) {
  if (!expression.test(value)) throw new Error(message);
}

function rejectMatch(value, expression, message) {
  if (expression.test(value)) throw new Error(message);
}

requireMatch(workflow, /workflow_dispatch:/, "Inventory must be manually triggered");
rejectMatch(workflow, /^\s+(push|pull_request|schedule):/m, "Inventory must not run automatically");
requireMatch(workflow, /id-token:\s*write/, "OIDC token permission is required");
requireMatch(workflow, /contents:\s*read/, "Repository token must remain read-only");
requireMatch(workflow, /GITHUB_REF.*refs\/heads\/main/, "Workflow must enforce main");
requireMatch(workflow, /allowed-account-ids:/, "AWS account must be explicitly allowlisted");
requireMatch(workflow, /role-duration-seconds:\s*900/, "STS session must remain short-lived");
requireMatch(workflow, /configure-aws-credentials@[0-9a-f]{40}/, "AWS action must be SHA-pinned");
requireMatch(workflow, /actions\/checkout@[0-9a-f]{40}/, "Checkout action must be SHA-pinned");
rejectMatch(workflow, /aws-access-key-id|aws-secret-access-key|secrets\./i, "Long-lived credentials are forbidden");

requireMatch(
  template,
  /repo:robert-lukowski@207513888\/stockguard-autonomous-procurement@1341560793:ref:refs\/heads\/main/,
  "IAM trust must use the immutable repository subject",
);
requireMatch(template, /token\.actions\.githubusercontent\.com:aud:\s*sts\.amazonaws\.com/, "IAM trust must validate the audience");
rejectMatch(
  template,
  /-\s+(connect|lambda|lex|dynamodb|kms|secretsmanager):(Create|Update|Delete|Put|Start|Stop|Associate|Disassociate|Tag|Untag)/,
  "Read-only role contains a write action",
);

requireMatch(inventory, /aws connect list-instances/, "Inventory must discover Connect safely");
requireMatch(inventory, /phoneNumbersInspected:\s*false/, "Summary must disclose that phone numbers were not inspected");
requireMatch(inventory, /resourcesChanged:\s*false/, "Summary must disclose that no resource changed");
rejectMatch(inventory, /list-phone-numbers|claim-phone-number|search-available-phone-number/, "Phone-number APIs are forbidden");
rejectMatch(
  inventory,
  /aws\s+(connect|lambda|lexv2-models|dynamodb|kms|secretsmanager)\s+(create|update|delete|put|start|stop|associate|disassociate|tag|untag)/i,
  "Inventory script contains an AWS write operation",
);

console.log("AWS read-only bootstrap invariants verified.");
