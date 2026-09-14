import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import { BlockonomicsProviderService } from "./services"

const services = [BlockonomicsProviderService]

export default ModuleProvider(Modules.PAYMENT, {
  services,
})
