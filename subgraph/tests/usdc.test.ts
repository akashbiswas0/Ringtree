import {
  afterAll,
  assert,
  beforeAll,
  clearStore,
  describe,
  test
} from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"
import { handleTransfer } from "../src/usdc"
import { createTransferEvent } from "./usdc-utils"

const FROM = "0x0000000000000000000000000000000000000001"
const TO = "0x0000000000000000000000000000000000000002"

describe("USDC activity", () => {
  beforeAll(() => {
    handleTransfer(
      createTransferEvent(
        Address.fromString(FROM),
        Address.fromString(TO),
        BigInt.fromI32(2500000)
      )
    )
  })

  afterAll(() => clearStore())

  test("indexes transfers and account aggregates", () => {
    assert.entityCount("Transfer", 1)
    assert.entityCount("Account", 2)
    assert.fieldEquals("Account", FROM, "sentAmount", "2500000")
    assert.fieldEquals("Account", TO, "receivedAmount", "2500000")
    assert.fieldEquals("USDCActivity", "global", "totalTransferCount", "1")
    assert.fieldEquals("USDCActivity", "global", "totalVolume", "2500000")
  })
})
