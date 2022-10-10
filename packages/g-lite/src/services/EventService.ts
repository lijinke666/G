import { inject, singleton } from 'mana-syringe';
import { EventEmitter } from 'eventemitter3';
import { mat4, vec3 } from 'gl-matrix';
import type { HTML } from '../display-objects';
import { DisplayObjectPool } from '../display-objects';
import { Element } from '../dom/Element';
import type { FederatedEvent } from '../dom/FederatedEvent';
import { FederatedMouseEvent } from '../dom/FederatedMouseEvent';
import { FederatedPointerEvent } from '../dom/FederatedPointerEvent';
import { FederatedWheelEvent } from '../dom/FederatedWheelEvent';
import type { ICanvas, IDocument, IEventTarget, INode } from '../dom/interfaces';
import { Node } from '../dom/Node';
import type { PointLike } from '../shapes';
import { Point } from '../shapes';
import type { Cursor, EventPosition } from '../types';
import { CanvasConfig } from '../types';
import { ContextService } from './ContextService';
import { RenderingContext } from './RenderingContext';

type Picker = (position: EventPosition) => Promise<IEventTarget | null>;
type TrackingData = {
  pressTargetsByButton: Record<number, IEventTarget[]>;
  clicksByButton: Record<
    number,
    {
      clickCount: number;
      target: IEventTarget;
      timeStamp: number;
    }
  >;
  overTargets: IEventTarget[] | null;
};
export type EmitterListeners = Record<
  string,
  | { fn: (...args: any[]) => any; context: any; once: boolean }[]
  | { fn: (...args: any[]) => any; context: any; once: boolean }
>;
const PROPAGATION_LIMIT = 2048;

@singleton()
export class EventService {
  constructor(
    @inject(RenderingContext)
    private renderingContext: RenderingContext,

    @inject(ContextService)
    private contextService: ContextService<any>,

    @inject(CanvasConfig)
    private canvasConfig: CanvasConfig,

    @inject(DisplayObjectPool)
    private displayObjectPool: DisplayObjectPool,
  ) {}

  private rootTarget: IEventTarget;

  private emitter = new EventEmitter();

  cursor: Cursor | null = 'default';

  private mappingTable: Record<
    string,
    {
      fn: (e: FederatedEvent) => Promise<void>;
      priority: number;
    }[]
  > = {};
  private mappingState: Record<string, any> = {
    trackingData: {},
  };
  private eventPool: Map<typeof FederatedEvent, FederatedEvent[]> = new Map();

  private pickHandler: Picker;

  private tmpMatrix = mat4.create();
  private tmpVec3 = vec3.create();

  init() {
    this.rootTarget = this.renderingContext.root.parentNode; // document
    this.addEventMapping('pointerdown', this.onPointerDown);
    this.addEventMapping('pointerup', this.onPointerUp);
    this.addEventMapping('pointermove', this.onPointerMove);
    this.addEventMapping('pointerout', this.onPointerOut);
    this.addEventMapping('pointerleave', this.onPointerOut);
    this.addEventMapping('pointerover', this.onPointerOver);
    this.addEventMapping('pointerupoutside', this.onPointerUpOutside);
    this.addEventMapping('wheel', this.onWheel);
  }

  client2Viewport(client: PointLike): PointLike {
    const bbox = this.contextService.getBoundingClientRect();
    return new Point(client.x - (bbox?.left || 0), client.y - (bbox?.top || 0));
  }

  viewport2Client(canvas: PointLike): PointLike {
    const bbox = this.contextService.getBoundingClientRect();
    return new Point(canvas.x + (bbox?.left || 0), canvas.y + (bbox?.top || 0));
  }

  viewport2Canvas({ x, y }: PointLike): PointLike {
    const canvas = (this.rootTarget as IDocument).defaultView;
    const camera = canvas.getCamera();

    const { width, height } = this.canvasConfig;

    const projectionMatrixInverse = camera.getPerspectiveInverse();
    const worldMatrix = camera.getWorldTransform();
    const vpMatrix = mat4.multiply(this.tmpMatrix, worldMatrix, projectionMatrixInverse);

    const viewport = vec3.set(this.tmpVec3, (x / width) * 2 - 1, (1 - y / height) * 2 - 1, 0);

    vec3.transformMat4(viewport, viewport, vpMatrix);

    return new Point(viewport[0], viewport[1]);
  }

  canvas2Viewport(canvasP: PointLike): PointLike {
    const canvas = (this.rootTarget as IDocument).defaultView;
    const camera = canvas.getCamera();

    // World -> Clip
    const projectionMatrix = camera.getPerspective();
    const viewMatrix = camera.getViewTransform();
    const vpMatrix = mat4.multiply(this.tmpMatrix, projectionMatrix, viewMatrix);

    const clip = vec3.set(this.tmpVec3, canvasP.x, canvasP.y, 0);
    vec3.transformMat4(this.tmpVec3, this.tmpVec3, vpMatrix);

    // Clip -> NDC -> Viewport, flip Y
    const { width, height } = this.canvasConfig;
    return new Point(((clip[0] + 1) / 2) * width, (1 - (clip[1] + 1) / 2) * height);
  }

  setPickHandler(pickHandler: Picker) {
    this.pickHandler = pickHandler;
  }

  addEventMapping(type: string, fn: (e: FederatedEvent) => Promise<void>) {
    if (!this.mappingTable[type]) {
      this.mappingTable[type] = [];
    }

    this.mappingTable[type].push({
      fn,
      priority: 0,
    });
    this.mappingTable[type].sort((a, b) => a.priority - b.priority);
  }

  mapEvent(e: FederatedEvent) {
    if (!this.rootTarget) {
      return;
    }

    const mappers = this.mappingTable[e.type];

    if (mappers) {
      for (let i = 0, j = mappers.length; i < j; i++) {
        mappers[i].fn(e);
      }
    } else {
      console.warn(`[EventService]: Event mapping not defined for ${e.type}`);
    }
  }

  onPointerDown = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const e = await this.createPointerEvent(from);

    this.dispatchEvent(e, 'pointerdown');

    if (e.pointerType === 'touch') {
      this.dispatchEvent(e, 'touchstart');
    } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      const isRightButton = e.button === 2;
      this.dispatchEvent(e, isRightButton ? 'rightdown' : 'mousedown');
    }

    const trackingData = this.trackingData(from.pointerId);

    trackingData.pressTargetsByButton[from.button] = e.composedPath();

    this.freeEvent(e);
  };

  onPointerUp = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const now = performance.now();
    const e = await this.createPointerEvent(from);

    this.dispatchEvent(e, 'pointerup');

    if (e.pointerType === 'touch') {
      this.dispatchEvent(e, 'touchend');
    } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      const isRightButton = e.button === 2;
      this.dispatchEvent(e, isRightButton ? 'rightup' : 'mouseup');
    }

    const trackingData = this.trackingData(from.pointerId);
    const pressTarget = this.findMountedTarget(trackingData.pressTargetsByButton[from.button]);

    let clickTarget = pressTarget;

    // pointerupoutside only bubbles. It only bubbles upto the parent that doesn't contain
    // the pointerup location.
    if (pressTarget && !e.composedPath().includes(pressTarget)) {
      let currentTarget: IEventTarget | null = pressTarget;

      while (currentTarget && !e.composedPath().includes(currentTarget)) {
        e.currentTarget = currentTarget;

        this.notifyTarget(e, 'pointerupoutside');

        if (e.pointerType === 'touch') {
          this.notifyTarget(e, 'touchendoutside');
        } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          const isRightButton = e.button === 2;

          this.notifyTarget(e, isRightButton ? 'rightupoutside' : 'mouseupoutside');
        }

        if (Node.isNode(currentTarget)) {
          currentTarget = currentTarget.parentNode;
        }
      }

      delete trackingData.pressTargetsByButton[from.button];

      // currentTarget is the most specific ancestor holding both the pointerdown and pointerup
      // targets. That is - it's our click target!
      clickTarget = currentTarget;
    }

    if (clickTarget) {
      const clickEvent = this.clonePointerEvent(e, 'click');

      clickEvent.target = clickTarget;
      clickEvent.path = [];

      if (!trackingData.clicksByButton[from.button]) {
        trackingData.clicksByButton[from.button] = {
          clickCount: 0,
          target: clickEvent.target,
          timeStamp: now,
        };
      }

      const clickHistory = trackingData.clicksByButton[from.button];

      if (clickHistory.target === clickEvent.target && now - clickHistory.timeStamp < 200) {
        ++clickHistory.clickCount;
      } else {
        clickHistory.clickCount = 1;
      }

      clickHistory.target = clickEvent.target;
      clickHistory.timeStamp = now;

      clickEvent.detail = clickHistory.clickCount;

      // @see https://github.com/antvis/G/issues/1091
      if (!e.detail?.preventClick) {
        if (clickEvent.pointerType === 'mouse' || clickEvent.pointerType === 'touch') {
          this.dispatchEvent(clickEvent, 'click');
        }
        this.dispatchEvent(clickEvent, 'pointertap');
      }

      this.freeEvent(clickEvent);
    }

    this.freeEvent(e);
  };

  onPointerMove = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const e = await this.createPointerEvent(from);
    const isMouse = e.pointerType === 'mouse' || e.pointerType === 'pen';
    const trackingData = this.trackingData(from.pointerId);
    const outTarget = this.findMountedTarget(trackingData.overTargets);

    // First pointerout/pointerleave
    if (trackingData.overTargets && outTarget !== e.target) {
      // pointerout always occurs on the overTarget when the pointer hovers over another element.
      const outType = from.type === 'mousemove' ? 'mouseout' : 'pointerout';
      const outEvent = await this.createPointerEvent(from, outType, outTarget || undefined);

      this.dispatchEvent(outEvent, 'pointerout');
      if (isMouse) this.dispatchEvent(outEvent, 'mouseout');

      // If the pointer exits overTarget and its descendants, then a pointerleave event is also fired. This event
      // is dispatched to all ancestors that no longer capture the pointer.
      if (!e.composedPath().includes(outTarget!)) {
        const leaveEvent = await this.createPointerEvent(
          from,
          'pointerleave',
          outTarget || undefined,
        );

        leaveEvent.eventPhase = leaveEvent.AT_TARGET;

        while (leaveEvent.target && !e.composedPath().includes(leaveEvent.target)) {
          leaveEvent.currentTarget = leaveEvent.target;

          this.notifyTarget(leaveEvent);
          if (isMouse) {
            this.notifyTarget(leaveEvent, 'mouseleave');
          }

          if (Node.isNode(leaveEvent.target)) {
            leaveEvent.target = leaveEvent.target.parentNode;
          }
        }

        this.freeEvent(leaveEvent);
      }

      this.freeEvent(outEvent);
    }

    // Then pointerover
    if (outTarget !== e.target) {
      // pointerover always occurs on the new overTarget
      const overType = from.type === 'mousemove' ? 'mouseover' : 'pointerover';
      const overEvent = this.clonePointerEvent(e, overType); // clone faster

      this.dispatchEvent(overEvent, 'pointerover');
      if (isMouse) this.dispatchEvent(overEvent, 'mouseover');

      // Probe whether the newly hovered Node is an ancestor of the original overTarget.
      let overTargetAncestor = outTarget && Node.isNode(outTarget) && outTarget.parentNode;

      while (
        overTargetAncestor &&
        overTargetAncestor !== (Node.isNode(this.rootTarget) && this.rootTarget.parentNode)
      ) {
        if (overTargetAncestor === e.target) break;

        overTargetAncestor = overTargetAncestor.parentNode;
      }

      // The pointer has entered a non-ancestor of the original overTarget. This means we need a pointerentered
      // event.
      const didPointerEnter =
        !overTargetAncestor ||
        overTargetAncestor === (Node.isNode(this.rootTarget) && this.rootTarget.parentNode);

      if (didPointerEnter) {
        const enterEvent = this.clonePointerEvent(e, 'pointerenter');

        enterEvent.eventPhase = enterEvent.AT_TARGET;

        while (
          enterEvent.target &&
          enterEvent.target !== outTarget &&
          enterEvent.target !== (Node.isNode(this.rootTarget) && this.rootTarget.parentNode)
        ) {
          enterEvent.currentTarget = enterEvent.target;

          this.notifyTarget(enterEvent);
          if (isMouse) this.notifyTarget(enterEvent, 'mouseenter');

          if (Node.isNode(enterEvent.target)) {
            enterEvent.target = enterEvent.target.parentNode;
          }
        }

        this.freeEvent(enterEvent);
      }

      this.freeEvent(overEvent);
    }

    // Then pointermove
    this.dispatchEvent(e, 'pointermove');

    if (e.pointerType === 'touch') this.dispatchEvent(e, 'touchmove');

    if (isMouse) {
      this.dispatchEvent(e, 'mousemove');
      this.cursor = this.getCursor(e.target);
    }

    trackingData.overTargets = e.composedPath();

    this.freeEvent(e);
  };

  onPointerOut = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const trackingData = this.trackingData(from.pointerId);

    if (trackingData.overTargets) {
      const isMouse = from.pointerType === 'mouse' || from.pointerType === 'pen';
      const outTarget = this.findMountedTarget(trackingData.overTargets);

      // pointerout first
      const outEvent = await this.createPointerEvent(from, 'pointerout', outTarget || undefined);

      this.dispatchEvent(outEvent);
      if (isMouse) this.dispatchEvent(outEvent, 'mouseout');

      // pointerleave(s) are also dispatched b/c the pointer must've left rootTarget and its descendants to
      // get an upstream pointerout event (upstream events do not know rootTarget has descendants).
      const leaveEvent = await this.createPointerEvent(
        from,
        'pointerleave',
        outTarget || undefined,
      );

      leaveEvent.eventPhase = leaveEvent.AT_TARGET;

      while (
        leaveEvent.target &&
        leaveEvent.target !== (Node.isNode(this.rootTarget) && this.rootTarget.parentNode)
      ) {
        leaveEvent.currentTarget = leaveEvent.target;

        this.notifyTarget(leaveEvent);
        if (isMouse) {
          this.notifyTarget(leaveEvent, 'mouseleave');
        }

        if (Node.isNode(leaveEvent.target)) {
          leaveEvent.target = leaveEvent.target.parentNode;
        }
      }

      trackingData.overTargets = null;

      this.freeEvent(outEvent);
      this.freeEvent(leaveEvent);
    }

    this.cursor = null;
  };

  onPointerOver = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const trackingData = this.trackingData(from.pointerId);
    const e = await this.createPointerEvent(from);

    const isMouse = e.pointerType === 'mouse' || e.pointerType === 'pen';

    this.dispatchEvent(e, 'pointerover');
    if (isMouse) this.dispatchEvent(e, 'mouseover');
    if (e.pointerType === 'mouse') this.cursor = this.getCursor(e.target);

    // pointerenter events must be fired since the pointer entered from upstream.
    const enterEvent = this.clonePointerEvent(e, 'pointerenter');

    enterEvent.eventPhase = enterEvent.AT_TARGET;

    while (
      enterEvent.target &&
      enterEvent.target !== (Node.isNode(this.rootTarget) && this.rootTarget.parentNode)
    ) {
      enterEvent.currentTarget = enterEvent.target;

      this.notifyTarget(enterEvent);
      if (isMouse) {
        // mouseenter should not bubble
        // @see https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseenter_event#usage_notes
        this.notifyTarget(enterEvent, 'mouseenter');
      }

      if (Node.isNode(enterEvent.target)) {
        enterEvent.target = enterEvent.target.parentNode;
      }
    }

    trackingData.overTargets = e.composedPath();

    this.freeEvent(e);
    this.freeEvent(enterEvent);
  };

  onPointerUpOutside = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedPointerEvent)) {
      return;
    }

    const trackingData = this.trackingData(from.pointerId);
    const pressTarget = this.findMountedTarget(trackingData.pressTargetsByButton[from.button]);
    const e = await this.createPointerEvent(from);

    if (pressTarget) {
      let currentTarget: IEventTarget | null = pressTarget;

      while (currentTarget) {
        e.currentTarget = currentTarget;

        this.notifyTarget(e, 'pointerupoutside');

        if (e.pointerType === 'touch') {
          // this.notifyTarget(e, 'touchendoutside');
        } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          this.notifyTarget(e, e.button === 2 ? 'rightupoutside' : 'mouseupoutside');
        }

        if (Node.isNode(currentTarget)) {
          currentTarget = currentTarget.parentNode;
        }
      }

      delete trackingData.pressTargetsByButton[from.button];
    }

    this.freeEvent(e);
  };

  onWheel = async (from: FederatedEvent) => {
    if (!(from instanceof FederatedWheelEvent)) {
      return;
    }

    const wheelEvent = await this.createWheelEvent(from);

    this.dispatchEvent(wheelEvent);
    this.freeEvent(wheelEvent);
  };

  dispatchEvent(e: FederatedEvent, type?: string) {
    e.propagationStopped = false;
    e.propagationImmediatelyStopped = false;

    this.propagate(e, type);
    this.emitter.emit(type || e.type, e);
  }

  propagate(e: FederatedEvent, type?: string) {
    if (!e.target) {
      return;
    }

    // [target, parent, root, Canvas]
    const composedPath = e.composedPath();

    // event flow: capture -> target -> bubbling

    // capture phase
    e.eventPhase = e.CAPTURING_PHASE;
    for (let i = composedPath.length - 1; i >= 1; i--) {
      e.currentTarget = composedPath[i];
      this.notifyTarget(e, type);
      if (e.propagationStopped || e.propagationImmediatelyStopped) return;
    }

    // target phase
    e.eventPhase = e.AT_TARGET;
    e.currentTarget = e.target;
    this.notifyTarget(e, type);
    if (e.propagationStopped || e.propagationImmediatelyStopped) return;

    // find current target in composed path
    const index = composedPath.indexOf(e.currentTarget);

    // bubbling phase
    e.eventPhase = e.BUBBLING_PHASE;
    for (let i = index + 1; i < composedPath.length; i++) {
      e.currentTarget = composedPath[i];
      this.notifyTarget(e, type);
      if (e.propagationStopped || e.propagationImmediatelyStopped) return;
    }
  }

  propagationPath(target: IEventTarget): IEventTarget[] {
    const propagationPath = [target];
    const canvas = (this.rootTarget as IDocument).defaultView || null;

    if (canvas && canvas === (target as unknown as ICanvas)) {
      propagationPath.unshift(canvas.document);
      return propagationPath;
    }

    for (let i = 0; i < PROPAGATION_LIMIT && target !== this.rootTarget; i++) {
      // if (Node.isNode(target) && !target.parentNode) {
      //   throw new Error('Cannot find propagation path to disconnected target');
      // }

      if (Node.isNode(target) && target.parentNode) {
        // [target, parent, parent, root]
        propagationPath.push(target.parentNode);
        target = target.parentNode;
      }
    }

    if (canvas) {
      // @ts-ignore
      propagationPath.push(canvas);
    }

    return propagationPath;
  }

  async hitTest(position: EventPosition): Promise<IEventTarget | null> {
    const { viewportX, viewportY } = position;
    const { width, height } = this.canvasConfig;
    // outside canvas
    if (viewportX < 0 || viewportY < 0 || viewportX > width || viewportY > height) {
      return null;
    }

    return (
      (await this.pickHandler(position)) ||
      this.rootTarget || // return Document
      null
    );
  }

  /**
   * whether the native event trigger came from Canvas,
   * should account for HTML shape
   */
  private isNativeEventFromCanvas(event: FederatedEvent) {
    const $el = this.contextService.getDomElement();

    const target = event.nativeEvent?.target;

    if (target) {
      // from <canvas>
      if (target === $el) {
        return true;
      }

      // from <svg>
      if ($el && ($el as unknown as HTMLCanvasElement).contains) {
        return ($el as unknown as HTMLCanvasElement).contains(target as any);
      }
    }

    if (event.nativeEvent.composedPath) {
      return event.nativeEvent.composedPath().indexOf($el) > -1;
    }

    // account for Touch
    return false;
  }

  private getExistedHTML(event: FederatedEvent): HTML {
    if (event.nativeEvent.composedPath) {
      const htmls = this.displayObjectPool.getHTMLs();
      for (const html of htmls) {
        if (event.nativeEvent.composedPath().indexOf(html) > -1) {
          return html;
        }
      }
    }

    return null;
  }

  private async pickTarget(event: FederatedPointerEvent | FederatedWheelEvent): Promise<INode> {
    return this.hitTest({
      clientX: event.clientX,
      clientY: event.clientY,
      viewportX: event.viewportX,
      viewportY: event.viewportY,
      x: event.canvasX,
      y: event.canvasY,
    }) as Promise<INode>;
  }

  private async createPointerEvent(
    from: FederatedPointerEvent,
    type?: string,
    target?: IEventTarget,
  ): Promise<FederatedPointerEvent> {
    const event = this.allocateEvent(FederatedPointerEvent);

    this.copyPointerData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from;

    const existedHTML = this.getExistedHTML(event);
    event.target =
      target ??
      (existedHTML || (this.isNativeEventFromCanvas(event) && (await this.pickTarget(event))));

    if (typeof type === 'string') {
      event.type = type;
    }

    return event;
  }

  private async createWheelEvent(from: FederatedWheelEvent): Promise<FederatedWheelEvent> {
    const event = this.allocateEvent(FederatedWheelEvent);

    this.copyWheelData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from;
    const existedHTML = this.getExistedHTML(event);
    event.target =
      existedHTML || (this.isNativeEventFromCanvas(event) && (await this.pickTarget(event)));
    return event;
  }

  private trackingData(id: number): TrackingData {
    if (!this.mappingState.trackingData[id]) {
      this.mappingState.trackingData[id] = {
        pressTargetsByButton: {},
        clicksByButton: {},
        overTarget: null,
      };
    }

    return this.mappingState.trackingData[id];
  }

  cloneWheelEvent(from: FederatedWheelEvent) {
    const event = this.allocateEvent(FederatedWheelEvent);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from.originalEvent;

    this.copyWheelData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.target = from.target;
    event.path = from.composedPath().slice();
    event.type = event.type;

    return event;
  }

  clonePointerEvent(from: FederatedPointerEvent, type?: string): FederatedPointerEvent {
    const event = this.allocateEvent(FederatedPointerEvent);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from.originalEvent;

    this.copyPointerData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.target = from.target;
    event.path = from.composedPath().slice();
    event.type = type ?? event.type;

    return event;
  }

  private copyPointerData(from: FederatedEvent, to: FederatedEvent) {
    if (!(from instanceof FederatedPointerEvent && to instanceof FederatedPointerEvent)) return;

    to.pointerId = from.pointerId;
    to.width = from.width;
    to.height = from.height;
    to.isPrimary = from.isPrimary;
    to.pointerType = from.pointerType;
    to.pressure = from.pressure;
    to.tangentialPressure = from.tangentialPressure;
    to.tiltX = from.tiltX;
    to.tiltY = from.tiltY;
    to.twist = from.twist;
  }

  private copyMouseData(from: FederatedEvent, to: FederatedEvent) {
    if (!(from instanceof FederatedMouseEvent && to instanceof FederatedMouseEvent)) return;

    to.altKey = from.altKey;
    to.button = from.button;
    to.buttons = from.buttons;
    to.ctrlKey = from.ctrlKey;
    to.metaKey = from.metaKey;
    to.shiftKey = from.shiftKey;
    to.client.copyFrom(from.client);
    to.movement.copyFrom(from.movement);
    to.canvas.copyFrom(from.canvas);
    to.screen.copyFrom(from.screen);
    to.global.copyFrom(from.global);
    to.offset.copyFrom(from.offset);
  }

  private copyWheelData(from: FederatedWheelEvent, to: FederatedWheelEvent) {
    to.deltaMode = from.deltaMode;
    to.deltaX = from.deltaX;
    to.deltaY = from.deltaY;
    to.deltaZ = from.deltaZ;
  }

  private copyData(from: FederatedEvent, to: FederatedEvent) {
    to.isTrusted = from.isTrusted;
    to.timeStamp = performance.now();
    to.type = from.type;
    to.detail = from.detail;
    to.view = from.view;
    to.page.copyFrom(from.page);
    to.viewport.copyFrom(from.viewport);
  }

  private allocateEvent<T extends FederatedEvent>(constructor: {
    new (boundary: EventService): T;
  }): T {
    if (!this.eventPool.has(constructor as any)) {
      this.eventPool.set(constructor as any, []);
    }

    // @ts-ignore
    const event = (this.eventPool.get(constructor as any).pop() as T) || new constructor(this);

    event.eventPhase = event.NONE;
    event.currentTarget = null;
    event.path = [];
    event.target = null;

    return event;
  }

  private freeEvent<T extends FederatedEvent>(event: T) {
    if (event.manager !== this)
      throw new Error('It is illegal to free an event not managed by this EventBoundary!');

    const { constructor } = event;

    if (!this.eventPool.has(constructor as any)) {
      this.eventPool.set(constructor as any, []);
    }

    // @ts-ignore
    this.eventPool.get(constructor as any).push(event);
  }

  private notifyTarget(e: FederatedEvent, type?: string) {
    type = type ?? e.type;
    const key =
      e.eventPhase === e.CAPTURING_PHASE || e.eventPhase === e.AT_TARGET ? `${type}capture` : type;

    this.notifyListeners(e, key);

    if (e.eventPhase === e.AT_TARGET) {
      this.notifyListeners(e, type);
    }
  }

  private notifyListeners(e: FederatedEvent, type: string) {
    // hack EventEmitter, stops if the `propagationImmediatelyStopped` flag is set
    // @ts-ignore
    const emitter = e.currentTarget.emitter;
    // @ts-ignore
    const listeners = (emitter._events as EmitterListeners)[type];

    if (!listeners) return;

    if ('fn' in listeners) {
      if (listeners.once) {
        emitter.removeListener(type, listeners.fn, undefined, true);
      }
      listeners.fn.call(e.currentTarget || listeners.context, e);
      // listeners.fn.call(listeners.context, e);
    } else {
      for (let i = 0; i < listeners.length && !e.propagationImmediatelyStopped; i++) {
        if (listeners[i].once) {
          emitter.removeListener(type, listeners[i].fn, undefined, true);
        }
        listeners[i].fn.call(e.currentTarget || listeners[i].context, e);
        // listeners[i].fn.call(listeners[i].context, e);
      }
    }
  }

  /**
   * some detached nodes may exist in propagation path, need to skip them
   */
  private findMountedTarget(propagationPath: IEventTarget[] | null): IEventTarget | null {
    if (!propagationPath) {
      return null;
    }

    let currentTarget = propagationPath[propagationPath.length - 1];
    for (let i = propagationPath.length - 2; i >= 0; i--) {
      const target = propagationPath[i];
      if (
        target === this.rootTarget ||
        (Node.isNode(target) && target.parentNode === currentTarget)
      ) {
        currentTarget = propagationPath[i];
      } else {
        break;
      }
    }

    return currentTarget;
  }

  private getCursor(target: IEventTarget | null) {
    let tmp: IEventTarget | null = target;
    while (tmp) {
      const cursor = Element.isElement(tmp) && tmp.getAttribute('cursor');
      if (cursor) {
        return cursor;
      }
      tmp = Node.isNode(tmp) && tmp.parentNode;
    }
  }
}