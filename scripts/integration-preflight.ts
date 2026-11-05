import { integrationPreflight } from "../packages/core/integrations";

console.log(JSON.stringify({check:"local_configuration_only", ...integrationPreflight()},null,2));
