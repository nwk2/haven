import { Navigate, Route, Routes } from "react-router-dom";
import { Ctx, type ModuleCtx } from "./ctx";
import { Home, ListPage } from "./screens";

/** To-dos, mounted by the shell under /m/todos/* (Technical spec › Module contract). */
export default function TodosModule({ ctx }: { ctx: ModuleCtx }) {
  return (
    <Ctx.Provider value={ctx}>
      <Routes>
        <Route index element={<Home />} />
        <Route path="list/:id" element={<ListPage />} />
        <Route path="*" element={<Navigate to="/m/todos" replace />} />
      </Routes>
    </Ctx.Provider>
  );
}
export type { ModuleCtx };
export { useNowHM } from "./data";
