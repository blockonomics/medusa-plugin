import BlockonomicsBase from "../core/blockonomics-base"
import { BlockonomicsOptions, PaymentProviderKeys } from "../types"

class BlockonomicsProviderService extends BlockonomicsBase {
  static identifier = PaymentProviderKeys.BLOCKONOMICS

  constructor(container, options: BlockonomicsOptions) {
    super(container, options)
  }
}

export default BlockonomicsProviderService
