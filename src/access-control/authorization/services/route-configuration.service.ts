import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  RequestMethod,
  Type,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { readDeclaration } from "../helpers/route-declaration";

export interface RouteConfigurationError {
  route: string;
  reason: string;
}

@Injectable()
export class RouteConfigurationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteConfigurationService.name);
  private errors: RouteConfigurationError[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  public onApplicationBootstrap() {
    this.errors = this.findErrors();
    for (const { route, reason } of this.errors) {
      this.logger.error(
        `Route configuration invalid reason=route_configuration route=${route}: ${reason}`,
      );
    }
  }

  public get ready() {
    return this.errors.length === 0;
  }

  public get invalidRoutes(): readonly RouteConfigurationError[] {
    return this.errors;
  }

  private findErrors() {
    const errors: RouteConfigurationError[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller || !wrapper.instance) {
        continue;
      }
      const prototype = Object.getPrototypeOf(wrapper.instance);
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) {
          continue;
        }
        const check = readDeclaration(this.reflector, handler, controller);
        if (!check.valid) {
          errors.push({ route: describeRoute(controller, handler, method), reason: check.reason });
        }
      }
    }
    return errors;
  }
}

function describeRoute(controller: Type<unknown>, handler: Function, method: RequestMethod) {
  const path = [controller, handler]
    .map((target) => firstPath(Reflect.getMetadata(PATH_METADATA, target)))
    .filter(Boolean)
    .join("/");
  return `${RequestMethod[method]} /${path}`;
}

function firstPath(path: string | string[] | undefined) {
  const value = Array.isArray(path) ? path[0] : path;
  return (value ?? "").replace(/^\/+|\/+$/g, "");
}
