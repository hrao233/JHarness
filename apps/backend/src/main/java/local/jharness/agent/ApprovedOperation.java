package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import java.util.function.Supplier;

@FunctionalInterface
interface ApprovedOperation {
    ToolResultBlock run(
            String operation,
            String path,
            String before,
            String after,
            String deniedMessage,
            Supplier<ToolResultBlock> action);
}
