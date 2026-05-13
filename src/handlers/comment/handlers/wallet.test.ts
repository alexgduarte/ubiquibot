import { extractEnsName, resolveAddress } from "./wallet";

describe("wallet ENS helpers", () => {
  test("extractEnsName returns the normalized ENS name", () => {
    expect(extractEnsName("PAVLOVCIK.ETH")).toBe("pavlovcik.eth");
  });

  test("resolveAddress uses the provided resolver", async () => {
    const resolveName = jest.fn().mockResolvedValue("0x1234567890123456789012345678901234567890");

    await expect(resolveAddress("pavlovcik.eth", { resolveName })).resolves.toBe(
      "0x1234567890123456789012345678901234567890"
    );
    expect(resolveName).toHaveBeenCalledWith("pavlovcik.eth");
  });

  test("resolveAddress returns null when the resolver fails", async () => {
    const resolveName = jest.fn().mockRejectedValue(new Error("provider unavailable"));
    const trace = jest.spyOn(console, "trace").mockImplementation(() => undefined);

    await expect(resolveAddress("pavlovcik.eth", { resolveName })).resolves.toBeNull();
    trace.mockRestore();
  });
});
