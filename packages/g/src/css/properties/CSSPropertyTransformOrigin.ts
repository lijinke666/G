import { singleton } from 'mana-syringe';
import type { CSSProperty } from '../CSSProperty';
import type { CSSUnitValue } from '../cssom';
import { parseTransformOrigin } from '../parser';

/**
 * @see https://developer.mozilla.org/zh-CN/docs/Web/CSS/transform-origin
 * @example
 * [10px, 10px] [10%, 10%]
 */
@singleton()
export class CSSPropertyTransformOrigin
  implements Partial<CSSProperty<[CSSUnitValue, CSSUnitValue], [CSSUnitValue, CSSUnitValue]>>
{
  parser = parseTransformOrigin;
}