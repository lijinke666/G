import type {
  DisplayObject,
  FederatedEvent,
  MutationEvent,
  RenderingPlugin,
  RenderingService,
  Text,
} from '@antv/g';
import {
  ContextService,
  ElementEvent,
  inject,
  isBrowser,
  RenderingContext,
  RenderingPluginContribution,
  Shape,
  singleton,
} from '@antv/g';
import { TextExtractor } from './TextExtractor';
import { A11yPluginOptions } from './tokens';

const KEY_CODE_TAB = 9;

@singleton({ contrib: RenderingPluginContribution })
export class A11yPlugin implements RenderingPlugin {
  static tag = 'A11y';

  @inject(RenderingContext)
  private renderingContext: RenderingContext;

  @inject(ContextService)
  private contextService: ContextService<unknown>;

  @inject(A11yPluginOptions)
  private a11yPluginOptions: A11yPluginOptions;

  @inject(TextExtractor)
  private textExtractor: TextExtractor;

  apply(renderingService: RenderingService) {
    const handleMounted = (e: FederatedEvent) => {
      const object = e.target as DisplayObject;

      if (object.nodeName === Shape.TEXT) {
        this.textExtractor.getOrCreateEl(object as Text);

        Object.keys(object.attributes).forEach((name) => {
          this.textExtractor.updateAttribute(name, object as Text);
        });
      }
    };

    const handleAttributeChanged = (e: MutationEvent) => {
      const object = e.target as DisplayObject;
      const { attrName } = e;

      if (object.nodeName === Shape.TEXT) {
        this.textExtractor.updateAttribute(attrName, object as Text);
      }
    };

    const handleUnmounted = (e: FederatedEvent) => {
      const object = e.target as DisplayObject;

      if (object.nodeName === Shape.TEXT) {
        this.textExtractor.removeEl(object as Text);
      }
    };

    renderingService.hooks.init.tapPromise(A11yPlugin.tag, async () => {
      const { enableExtractingText } = this.a11yPluginOptions;
      if (enableExtractingText && !this.isSVG()) {
        this.textExtractor.activate();
        this.renderingContext.root.addEventListener(ElementEvent.MOUNTED, handleMounted);
        this.renderingContext.root.addEventListener(ElementEvent.UNMOUNTED, handleUnmounted);
        this.renderingContext.root.addEventListener(
          ElementEvent.ATTR_MODIFIED,
          handleAttributeChanged,
        );
      }

      globalThis.addEventListener('keydown', this.onKeyDown, false);
    });

    renderingService.hooks.destroy.tap(A11yPlugin.tag, () => {
      const { enableExtractingText } = this.a11yPluginOptions;
      if (enableExtractingText && !this.isSVG()) {
        this.textExtractor.deactivate();
        this.renderingContext.root.removeEventListener(ElementEvent.MOUNTED, handleMounted);
        this.renderingContext.root.removeEventListener(ElementEvent.UNMOUNTED, handleUnmounted);
        this.renderingContext.root.removeEventListener(
          ElementEvent.ATTR_MODIFIED,
          handleAttributeChanged,
        );
      }

      globalThis.removeEventListener('keydown', this.onKeyDown, false);
    });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.keyCode !== KEY_CODE_TAB) {
      return;
    }

    this.activate();
  };

  private activate() {}

  private isSVG() {
    return isBrowser && this.contextService.getDomElement() instanceof SVGSVGElement;
  }
}