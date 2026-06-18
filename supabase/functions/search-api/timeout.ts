export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs = 10000
): Promise<T> {

    return await Promise.race([

        promise,

        new Promise<T>((_, reject) =>

            setTimeout(() => reject(new Error("API timeout")), timeoutMs)

        )

    ]);

}