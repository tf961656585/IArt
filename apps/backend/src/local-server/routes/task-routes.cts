import type { RouteDefinition } from "../http/route-registry.cts";
import { createTaskReadRoutes } from "./task-read-routes.cts";
import { createTaskSubmitRoutes } from "./task-submit-routes.cts";

const createTaskRoutes = (): RouteDefinition[] => [...createTaskSubmitRoutes(), ...createTaskReadRoutes()];

export { createTaskRoutes };
